import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import {
  databaseAdapter,
  normalizePagination,
  readCount,
  requireFound,
  type DatabaseExecutor,
  type Page,
  type PaginationInput,
} from "@/lib/database";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  accounts,
  profileEvents,
  profiles,
  type AccountRow,
  type ProfileRow,
} from "@/lib/drizzle/schema";
import {
  accountCanAllocateSql,
  accountIsLiveSql,
  isSellableSlotSql,
  profileIsFreeSql,
} from "@/lib/drizzle/predicates";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail } from "@/utils/result";
import { resolveValidity } from "../services/account-validity";
import { PROFILE_NUMBERS } from "../validation/profile.schema";
import type { AccountInsert, AccountUpdate } from "../validation/account.schema";

/**
 * Accounts repository.
 *
 * Owns the account aggregate: an account and the five profiles that constitute
 * it. Profiles are not created independently, which is why there is no
 * standalone profile-creation method anywhere in this module.
 *
 * Two rules are enforced here rather than left to callers:
 *
 * 1. Exactly five profiles per account. Written in the same transaction as the
 *    account, so an account with four profiles is never observable — not even
 *    briefly, and not if the process dies mid-write.
 *
 * 2. The password is encrypted before it reaches the column. Callers pass
 *    plaintext and cannot pass ciphertext, so an unencrypted value cannot be
 *    written into `password_encrypted`.
 */

const ENTITY = "Account";

/**
 * The account exists.
 *
 * Kept as a local name because it reads better at the twelve call sites below,
 * but the rule itself now lives in lib/drizzle/predicates — the dashboard and
 * reports aggregates express the same test in raw SQL, and this is the page they
 * are agreeing with. One definition, two syntaxes.
 */
const liveOnly = accountIsLiveSql;

/** Columns the accounts list may be ordered by. */
export type AccountSortField = "email" | "status" | "healthScore" | "country" | "createdAt";

export interface AccountFilter extends PaginationInput {
  readonly status?: AccountRow["status"] | undefined;
  readonly country?: string | undefined;
  /** Matches email, notes, or country. Never the password — it is encrypted. */
  readonly search?: string | undefined;
  readonly sortBy?: AccountSortField | undefined;
  readonly sortDirection?: "asc" | "desc" | undefined;
}

/**
 * An account row plus its profile tallies.
 *
 * The counts are aggregated in SQL rather than by loading five profiles per row.
 * A 25-row page would otherwise issue 25 extra queries, or return 125 profile
 * rows the list never displays.
 */
export interface AccountWithCounts {
  readonly account: AccountRow;
  /**
   * Genuinely sellable right now: within profile_slots AND free.
   *
   * Both halves are derived in SQL through `lib/drizzle/predicates`, so this
   * count and the allocation engine cannot disagree about what is on the shelf.
   */
  readonly availableProfiles: number;
  readonly soldProfiles: number;
  /** Slots above the account's profile_slots. Never stock, never will be. */
  readonly notForSaleProfiles: number;
  /**
   * Sold, but the customer's time has run out.
   *
   * Derived from expiration_date, not from status — nothing ever writes
   * `expired`. These are allocatable again on a healthy account, per
   * 03_DATABASE.md, so a list showing them as plain "sold" understates stock.
   */
  readonly expiredProfiles: number;
  /**
   * The account's five profile rows, ordered 1 to 5.
   *
   * Fetched for the whole page in ONE extra query, not one per account: a
   * 25-row page would otherwise issue 25 round trips to render its indicators.
   *
   * Raw rows, deliberately. The service turns them into display states through
   * `profileCellState`; handing a component the status column would invite it
   * to invent its own interpretation, which M13 §7 forbids.
   */
  readonly profiles: readonly ProfileRow[];
}

export interface AccountsRepository {
  findById(id: string): Promise<Result<AccountRow>>;
  findByEmail(email: string): Promise<Result<AccountRow>>;
  list(filter?: AccountFilter): Promise<Result<Page<AccountRow>>>;
  /** The accounts list screen. Includes available and sold profile tallies. */
  listWithCounts(filter?: AccountFilter): Promise<Result<Page<AccountWithCounts>>>;
  /** Restores an archived account to healthy. */
  restore(id: string): Promise<Result<AccountRow>>;
  /** Creates the account and all five profiles atomically. */
  create(input: AccountInsert, createdBy: string | null): Promise<Result<AccountRow>>;
  /**
   * Creates a batch under one transaction, skipping emails already taken.
   *
   * Returns what was written and which addresses were already in use, so the
   * caller can report every submitted row as imported or rejected.
   */
  createMany(
    inputs: readonly AccountInsert[],
    createdBy: string | null,
  ): Promise<Result<{ created: readonly AccountRow[]; skippedEmails: readonly string[] }>>;
  /**
   * Sets the sellable slot count and moves the profile rows to match.
   *
   * Fails when a profile above the new count is still allocated — that customer
   * would otherwise be silently stranded.
   */
  setProfileSlots(id: string, profileSlots: number): Promise<Result<AccountRow>>;
  update(id: string, input: AccountUpdate): Promise<Result<AccountRow>>;
  /** Decrypts the stored password. Never expose the result to a client. */
  revealPassword(id: string): Promise<Result<string>>;
  archive(id: string): Promise<Result<AccountRow>>;
  softDelete(id: string): Promise<Result<AccountRow>>;
}

function buildFilter(filter: AccountFilter) {
  const conditions = [liveOnly];

  if (filter.status !== undefined) {
    conditions.push(eq(accounts.status, filter.status));
  }

  if (filter.country !== undefined) {
    conditions.push(eq(accounts.country, filter.country));
  }

  if (filter.search?.trim()) {
    const term = `%${filter.search.trim()}%`;
    const match = or(
      ilike(accounts.email, term),
      ilike(accounts.notes, term),
      ilike(accounts.country, term),
    );

    if (match !== undefined) {
      conditions.push(match);
    }
  }

  return and(...conditions);
}

const SORT_COLUMNS = {
  email: accounts.email,
  status: accounts.status,
  healthScore: accounts.healthScore,
  country: accounts.country,
  createdAt: accounts.createdAt,
} as const;

/**
 * Resolves sort input to a column.
 *
 * A lookup table rather than string interpolation: an arbitrary column name from
 * a query string must never reach SQL.
 */
function resolveOrderBy(filter: AccountFilter) {
  const column = SORT_COLUMNS[filter.sortBy ?? "createdAt"];
  return filter.sortDirection === "asc" ? asc(column) : desc(column);
}

/**
 * Writes one account, its five profile rows and their opening history entries.
 *
 * Shared by `create` and `createMany` so a bulk import cannot diverge from a
 * single creation — same profile rows, same slot handling, same events. It runs
 * inside a transaction the caller already opened, which is what lets createMany
 * put an entire batch under one.
 *
 * All five rows are always written. 01_MASTER_RULES.md forbids a dynamic
 * profile count and nothing here changes that; `profile_slots` decides which of
 * the five are stock, and the rest are born `not_for_sale` rather than absent.
 */
async function insertAccountWithProfiles(
  executor: DatabaseExecutor,
  input: AccountInsert,
  passwordEncrypted: string,
  createdBy: string | null,
  /**
   * When true, an email already taken by a live account skips the row and
   * returns null instead of throwing. Used by bulk import so one duplicate
   * cannot discard an operator's other 199 rows.
   */
  skipDuplicateEmail = false,
): Promise<AccountRow | null> {
  /* Not columns: one is a secret handled above, one is an input to validity. */
  const { password: _password, durationDays, ...accountFields } = input;

  const validity = resolveValidity(
    {
      ...(accountFields.validFrom === undefined ? {} : { validFrom: accountFields.validFrom }),
      ...(accountFields.validUntil === undefined ? {} : { validUntil: accountFields.validUntil }),
      ...(durationDays === undefined ? {} : { durationDays }),
    },
    new Date(),
  );

  const insert = executor.insert(accounts).values({
    ...accountFields,
    validFrom: validity.validFrom,
    validUntil: validity.validUntil,
    passwordEncrypted,
    createdBy,
  });

  /*
   * Targets accounts_email_unique_live, the PARTIAL index — so a soft-deleted
   * account holding the same address does not block re-registering it, exactly
   * as a single creation behaves.
   */
  const [account] = skipDuplicateEmail
    ? await insert
        /* `where` is the index predicate, matching accounts_email_unique_live. */
        .onConflictDoNothing({ target: accounts.email, where: isNull(accounts.deletedAt) })
        .returning()
    : await insert.returning();

  if (!account) {
    if (skipDuplicateEmail) {
      /* The address was taken. Nothing was written, so there is nothing to undo. */
      return null;
    }

    /*
     * Unreachable without the conflict clause: an insert that returns no row has
     * already thrown. Throwing here rolls the transaction back rather than
     * returning a half-built account, and satisfies the compiler without a
     * non-null assertion.
     */
    throw new Error("Insert returned no account row");
  }

  /* The five-profile rule. All five, or none — the transaction guarantees it. */
  const createdProfiles = await executor
    .insert(profiles)
    .values(
      /*
       * No status stamped here. Every row is born `available`, and whether it
       * is sellable is derived from profile_number against the account's
       * profile_slots at read time — so lowering or raising the slot count
       * needs no rewrite and can never leave a row disagreeing with the column.
       */
      PROFILE_NUMBERS.map((profileNumber) => ({
        accountId: account.id,
        profileNumber,
      })),
    )
    .returning({ id: profiles.id });

  /* Opening entry in each profile's history. ADR-006: account_id included. */
  await executor.insert(profileEvents).values(
    createdProfiles.map((profile) => ({
      accountId: account.id,
      profileId: profile.id,
      eventType: "created" as const,
      userId: createdBy,
    })),
  );

  return account;
}

export const accountsRepository: AccountsRepository = {
  async findById(id) {
    const result = await databaseAdapter.query("accounts.findById", (executor) =>
      executor
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, id), liveOnly))
        .limit(1),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  async findByEmail(email) {
    const normalized = email.trim().toLowerCase();

    const result = await databaseAdapter.query("accounts.findByEmail", (executor) =>
      executor
        .select()
        .from(accounts)
        .where(and(eq(accounts.email, normalized), liveOnly))
        .limit(1),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, normalized);
  },

  async list(filter = {}) {
    const { limit, offset } = normalizePagination(filter);
    const where = buildFilter(filter);

    return databaseAdapter.transaction("accounts.list", async (executor) => {
      const items = await executor
        .select()
        .from(accounts)
        .where(where)
        .orderBy(resolveOrderBy(filter))
        .limit(limit)
        .offset(offset);

      const totals = await executor.select({ count: count() }).from(accounts).where(where);

      return { items, total: readCount(totals), limit, offset };
    });
  },

  async listWithCounts(filter = {}) {
    const { limit, offset } = normalizePagination(filter);
    const where = buildFilter(filter);

    return databaseAdapter.transaction("accounts.listWithCounts", async (executor) => {
      /*
       * Counts come from a LEFT JOIN with FILTER aggregates, so an account with
       * no matching profiles still appears with zeroes rather than dropping out
       * of the list. One query, one pass.
       */
      const rows = await executor
        .select({
          account: accounts,
          /*
           * Sellable AND free AND the account may sell.
           *
           * The first two halves are derived: the slot rule from profile_number
           * against profile_slots, and freedom from the expiration date rather
           * than the never-written `expired` status.
           *
           * The third is account-level and was missing. A row could report four
           * available profiles while the account carried an open problem, so the
           * list advertised stock Quick Prepare would never allocate. Same
           * predicate the engine uses, so the two cannot disagree.
           */
          availableProfiles: sql<number>`count(*) filter (
            where ${isSellableSlotSql} and ${profileIsFreeSql} and ${accountCanAllocateSql}
          )::int`,
          soldProfiles: sql<number>`count(*) filter (
            where ${profiles.status} = 'sold' and not ${profileIsFreeSql}
          )::int`,
          /* Slots above profile_slots. Never stock, and never will be. */
          notForSaleProfiles: sql<number>`count(*) filter (where not ${isSellableSlotSql})::int`,
          /* Sold, but the customer's time has run out — allocatable again. */
          expiredProfiles: sql<number>`count(*) filter (
            where ${profiles.expirationDate} is not null
              and ${profiles.expirationDate} < current_date
          )::int`,
        })
        .from(accounts)
        .leftJoin(profiles, eq(profiles.accountId, accounts.id))
        .where(where)
        .groupBy(accounts.id)
        .orderBy(resolveOrderBy(filter))
        .limit(limit)
        .offset(offset);

      const totals = await executor.select({ count: count() }).from(accounts).where(where);

      /*
       * One query for every profile on the page, grouped in memory. The
       * alternative — a lateral join or an aggregate — would either duplicate
       * the account row five times or return the profiles as JSON that still
       * needs parsing.
       */
      const accountIds = rows.map((row) => row.account.id);

      const profileRows =
        accountIds.length === 0
          ? []
          : await executor
              .select()
              .from(profiles)
              .where(inArray(profiles.accountId, accountIds))
              .orderBy(asc(profiles.accountId), asc(profiles.profileNumber));

      const byAccount = new Map<string, ProfileRow[]>();

      for (const profile of profileRows) {
        const existing = byAccount.get(profile.accountId);
        if (existing) existing.push(profile);
        else byAccount.set(profile.accountId, [profile]);
      }

      return {
        items: rows.map((row) => ({ ...row, profiles: byAccount.get(row.account.id) ?? [] })),
        total: readCount(totals),
        limit,
        offset,
      };
    });
  },

  /**
   * Creates an account with its five profiles.
   *
   * Encryption happens before the transaction opens. A failing encrypt must not
   * hold a database transaction open while it fails.
   */
  async create(input, createdBy) {
    const encrypted = encryptSecret(input.password);

    if (!encrypted.ok) {
      return encrypted;
    }

    return databaseAdapter.transaction("accounts.create", async (executor) => {
      const account = await insertAccountWithProfiles(executor, input, encrypted.value, createdBy);

      if (!account) {
        /* Unreachable: without skipDuplicateEmail the helper throws instead. */
        throw new Error("Insert returned no account row");
      }

      return account;
    });
  },

  /**
   * Creates many accounts under ONE transaction, skipping emails already taken.
   *
   * Partial success by design, and the design matters: the skip is decided by
   * the DATABASE, via `on conflict do nothing` against the live-email unique
   * index, not by a prior SELECT. A pre-check would be a race — two operators
   * importing overlapping lists would both see the address free and the second
   * would fail the whole batch on a constraint it had already cleared.
   *
   * A row that conflicts inserts nothing and returns nothing, so it never gets
   * profiles or events either. The caller diffs what it asked for against what
   * came back and reports the difference per row.
   *
   * Still one transaction: a batch either applies as a unit or not at all, so a
   * crash halfway cannot leave an account without its five profiles.
   *
   * Encryption happens up front, outside the transaction. Encrypting fifty
   * passwords while holding one open would keep it open for no reason.
   */
  async createMany(inputs, createdBy) {
    const encryptedPasswords: string[] = [];

    for (const input of inputs) {
      const encrypted = encryptSecret(input.password);

      if (!encrypted.ok) {
        return encrypted;
      }

      encryptedPasswords.push(encrypted.value);
    }

    return databaseAdapter.transaction("accounts.createMany", async (executor) => {
      const created: AccountRow[] = [];
      const skippedEmails: string[] = [];

      for (const [index, input] of inputs.entries()) {
        const account = await insertAccountWithProfiles(
          executor,
          input,
          encryptedPasswords[index] ?? "",
          createdBy,
          /* Let a duplicate email skip the row instead of failing the batch. */
          true,
        );

        if (account === null) {
          skippedEmails.push(input.email);
          continue;
        }

        created.push(account);
      }

      return { created, skippedEmails };
    });
  },

  /**
   * Changes the sellable slot count.
   *
   * ONE write. Because sellability is derived, no profile row has to move —
   * which is the whole point of deriving it. There is no window in which the
   * column and the rows disagree, because there are no rows to disagree.
   *
   * Still a transaction, and still takes row locks, for the occupancy check
   * below: without them a Quick Prepare running concurrently could sell profile
   * 4 in the instant between the check and the update, leaving a customer
   * holding a slot that is no longer stock.
   *
   * Refuses to shrink past an occupied slot. If a customer holds a profile above
   * the new count, honouring the change would either strand them or silently
   * cancel their subscription, and an inventory setting must not be able to do
   * either. The transaction throws and the service turns it into a field error.
   */
  async setProfileSlots(id, profileSlots) {
    return databaseAdapter.transaction("accounts.setProfileSlots", async (executor) => {
      const rows = await executor
        .select()
        .from(profiles)
        .where(eq(profiles.accountId, id))
        .for("update");

      const occupiedAbove = rows.filter(
        (row) => row.profileNumber > profileSlots && row.customerId !== null,
      );

      if (occupiedAbove.length > 0) {
        const numbers = occupiedAbove.map((row) => row.profileNumber).join(", ");

        throw new ValidationError(
          `Profiles ${numbers} are allocated and cannot be taken out of stock`,
          {
            userMessage:
              `Profile ${numbers} still belongs to a customer. ` +
              "Release or replace that allocation before reducing the profile count.",
            fieldErrors: { profileSlots: `Profile ${numbers} is still allocated` },
          },
        );
      }

      const [account] = await executor
        .update(accounts)
        .set({ profileSlots, updatedAt: sql`now()` })
        .where(and(eq(accounts.id, id), liveOnly))
        .returning();

      if (!account) {
        throw new NotFoundError(`${ENTITY} ${id} not found`);
      }

      return account;
    });
  },

  async update(id, input) {
    const { password, ...fields } = input;

    /*
     * Only re-encrypt when a new password was supplied. Encrypting on every
     * update would change the ciphertext for an unchanged password, which makes
     * audit diffs show a password change that never happened.
     */
    let passwordEncrypted: string | undefined;

    if (password !== undefined) {
      const encrypted = encryptSecret(password);

      if (!encrypted.ok) {
        return encrypted;
      }

      passwordEncrypted = encrypted.value;
    }

    const result = await databaseAdapter.query("accounts.update", (executor) =>
      executor
        .update(accounts)
        .set({
          ...fields,
          ...(passwordEncrypted === undefined ? {} : { passwordEncrypted }),
          updatedAt: sql`now()`,
        })
        .where(and(eq(accounts.id, id), liveOnly))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  /**
   * Decrypts the stored password.
   *
   * Separate from `findById` on purpose. Reading an account is routine; reading
   * its password is not, and it should be visible in the code that a caller
   * asked for the secret. The result must never be returned to a browser or
   * written to a log.
   */
  async revealPassword(id) {
    const result = await databaseAdapter.query("accounts.revealPassword", (executor) =>
      executor
        .select({ passwordEncrypted: accounts.passwordEncrypted })
        .from(accounts)
        .where(and(eq(accounts.id, id), liveOnly))
        .limit(1),
    );

    if (!result.ok) {
      return result;
    }

    const row = requireFound(result.value[0], ENTITY, id);

    if (!row.ok) {
      return fail(row.error);
    }

    return decryptSecret(row.value.passwordEncrypted);
  },

  /**
   * Archives an account.
   *
   * Distinct from deletion: 01_MASTER_RULES.md lists Archived and Deleted as
   * separate statuses. Archiving is reversible and keeps the account readable.
   */
  async archive(id) {
    const result = await databaseAdapter.query("accounts.archive", (executor) =>
      executor
        .update(accounts)
        .set({ status: "archived", archivedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(accounts.id, id), liveOnly))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  /**
   * Restores an archived account.
   *
   * Returns it to `healthy` and clears archived_at. Deliberately refuses to
   * restore a soft-deleted account: `liveOnly` excludes those, so a deleted
   * record cannot be revived through the archive path.
   */
  async restore(id) {
    const result = await databaseAdapter.query("accounts.restore", (executor) =>
      executor
        .update(accounts)
        .set({ status: "healthy", archivedAt: null, updatedAt: sql`now()` })
        .where(and(eq(accounts.id, id), liveOnly))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  /**
   * Soft delete.
   *
   * Profiles are left in place. They cascade only on a hard delete, and the
   * partial unique index on email excludes deleted rows so the address can be
   * registered again.
   */
  async softDelete(id) {
    const result = await databaseAdapter.query("accounts.softDelete", (executor) =>
      executor
        .update(accounts)
        .set({ status: "deleted", deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(accounts.id, id), liveOnly))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },
};
