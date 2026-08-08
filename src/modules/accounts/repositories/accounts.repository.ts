import { and, asc, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";

import {
  databaseAdapter,
  normalizePagination,
  readCount,
  requireFound,
  type Page,
  type PaginationInput,
} from "@/lib/database";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { accounts, profileEvents, profiles, type AccountRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import { fail } from "@/utils/result";
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

const liveOnly = isNull(accounts.deletedAt);

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
  readonly availableProfiles: number;
  readonly soldProfiles: number;
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
          availableProfiles: sql<number>`count(*) filter (where ${profiles.status} = 'available')::int`,
          soldProfiles: sql<number>`count(*) filter (where ${profiles.status} = 'sold')::int`,
        })
        .from(accounts)
        .leftJoin(profiles, eq(profiles.accountId, accounts.id))
        .where(where)
        .groupBy(accounts.id)
        .orderBy(resolveOrderBy(filter))
        .limit(limit)
        .offset(offset);

      const totals = await executor.select({ count: count() }).from(accounts).where(where);

      return { items: rows, total: readCount(totals), limit, offset };
    });
  },

  /**
   * Creates an account with its five profiles.
   *
   * Encryption happens before the transaction opens. A failing encrypt must not
   * hold a database transaction open while it fails.
   */
  async create(input, createdBy) {
    const { password, ...accountFields } = input;

    const encrypted = encryptSecret(password);

    if (!encrypted.ok) {
      return encrypted;
    }

    return databaseAdapter.transaction("accounts.create", async (executor) => {
      const [account] = await executor
        .insert(accounts)
        .values({ ...accountFields, passwordEncrypted: encrypted.value, createdBy })
        .returning();

      if (!account) {
        /*
         * Unreachable: an insert that returns no row has already thrown. Throwing
         * here rolls the transaction back rather than returning a half-built
         * account, and satisfies the compiler without a non-null assertion.
         */
        throw new Error("Insert returned no account row");
      }

      /* The five-profile rule. All five, or none — the transaction guarantees it. */
      const createdProfiles = await executor
        .insert(profiles)
        .values(
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
