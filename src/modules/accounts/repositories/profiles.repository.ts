import { and, asc, count, desc, eq, isNull, lte, sql } from "drizzle-orm";

import {
  databaseAdapter,
  normalizePagination,
  readCount,
  requireFound,
  type Page,
  type PaginationInput,
} from "@/lib/database";
import { accountStillCoveredSql, isSellableSlotSql } from "@/lib/drizzle/predicates";
import {
  accounts,
  profileEvents,
  profiles,
  type ProfileEventRow,
  type ProfileRow,
} from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import { ok } from "@/utils/result";

import type { ProfileEventInsert, ProfileUpdate } from "../validation/profile.schema";

/**
 * Profiles repository.
 *
 * Part of the accounts aggregate. There is deliberately no `create` here:
 * profiles exist only as the five members of an account, written by
 * accountsRepository.create. Exposing profile creation would make the
 * five-profile rule bypassable.
 *
 * Profile history is written through `recordEvent`, which is append-only —
 * profile_events has no update or delete method anywhere, because
 * 01_MASTER_RULES.md requires history that is never modified.
 */

const ENTITY = "Profile";
/**
 * Statuses that mean a customer is holding this slot.
 *
 * `expired` is not here. Its allocation has run out but the row still carries
 * the customer for history, and the schema leaves that case unconstrained on
 * purpose — clearing it is a business rule no document states.
 */
const HELD_STATUSES: readonly ProfileRow["status"][] = ["sold", "reserved", "expiring_soon"];

export interface ProfileFilter extends PaginationInput {
  readonly accountId?: string | undefined;
  readonly status?: ProfileRow["status"] | undefined;
  readonly customerId?: string | undefined;
}

export interface ProfilesRepository {
  findById(id: string): Promise<Result<ProfileRow>>;
  listByAccount(accountId: string): Promise<Result<readonly ProfileRow[]>>;
  list(filter?: ProfileFilter): Promise<Result<Page<ProfileRow>>>;
  /**
   * Profiles genuinely sellable right now.
   *
   * 01_MASTER_RULES.md: if an account is not healthy, ALL of its profiles become
   * unavailable, with no exceptions. Availability therefore requires joining the
   * account — profile status alone is not an answer.
   */
  findAvailable(limit?: number): Promise<Result<readonly ProfileRow[]>>;
  /** Profiles expiring on or before the given date. Drives the expiry sweep. */
  findExpiringOnOrBefore(date: string): Promise<Result<readonly ProfileRow[]>>;
  update(id: string, input: ProfileUpdate): Promise<Result<ProfileRow>>;
  recordEvent(input: ProfileEventInsert): Promise<Result<ProfileEventRow>>;
  listEvents(
    profileId: string,
    pagination?: PaginationInput,
  ): Promise<Result<Page<ProfileEventRow>>>;
  /**
   * The account timeline.
   *
   * ADR-006 Decision 1: profile_events is the only event source, and account
   * history is this query. The account_id column exists so it reads one index
   * range instead of joining through profiles.
   */
  listAccountEvents(
    accountId: string,
    pagination?: PaginationInput,
  ): Promise<Result<Page<ProfileEventRow>>>;
  countByAccount(accountId: string): Promise<Result<number>>;
  /**
   * Returns a held profile to stock, atomically.
   *
   * Clears the allocation rather than only the status. `profiles_held_requires_
   * customer` refuses an `available` row that still points at a customer, so a
   * status-only write would be rejected by the database — which is the correct
   * outcome, and the reason the whole allocation must go together.
   *
   * The profile row, its number and its account are untouched. The customer row
   * is untouched. The event is written in the same transaction, so history
   * cannot exist without the change or the change without its history.
   */
  releaseSale(id: string, actorId: string | null): Promise<Result<ReleaseSaleOutcome>>;
}

/**
 * What happened when a release was attempted.
 *
 * Three outcomes rather than a boolean, because the caller needs to tell a
 * vanished profile from one somebody else already freed — those are different
 * sentences for the operator.
 */
export type ReleaseSaleOutcome =
  | { readonly outcome: "released"; readonly before: ProfileRow; readonly after: ProfileRow }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "not_sold"; readonly current: ProfileRow };

function buildFilter(filter: ProfileFilter) {
  const conditions = [];

  if (filter.accountId !== undefined) {
    conditions.push(eq(profiles.accountId, filter.accountId));
  }

  if (filter.status !== undefined) {
    conditions.push(eq(profiles.status, filter.status));
  }

  if (filter.customerId !== undefined) {
    conditions.push(eq(profiles.customerId, filter.customerId));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

export const profilesRepository: ProfilesRepository = {
  async findById(id) {
    const result = await databaseAdapter.query("profiles.findById", (executor) =>
      executor.select().from(profiles).where(eq(profiles.id, id)).limit(1),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  /** Always five rows for a live account, ordered 1 to 5 for stable display. */
  async listByAccount(accountId) {
    return databaseAdapter.query("profiles.listByAccount", (executor) =>
      executor
        .select()
        .from(profiles)
        .where(eq(profiles.accountId, accountId))
        .orderBy(asc(profiles.profileNumber)),
    );
  },

  async list(filter = {}) {
    const { limit, offset } = normalizePagination(filter);
    const where = buildFilter(filter);

    return databaseAdapter.transaction("profiles.list", async (executor) => {
      const items = await executor
        .select()
        .from(profiles)
        .where(where)
        .orderBy(desc(profiles.updatedAt))
        .limit(limit)
        .offset(offset);

      const totals = await executor.select({ count: count() }).from(profiles).where(where);

      return { items, total: readCount(totals), limit, offset };
    });
  },

  async findAvailable(limit = 50) {
    return databaseAdapter.query("profiles.findAvailable", async (executor) => {
      const rows = await executor
        .select({ profile: profiles })
        .from(profiles)
        .innerJoin(accounts, eq(profiles.accountId, accounts.id))
        .where(
          and(
            eq(profiles.status, "available"),
            /* The unhealthy-account rule, applied in SQL rather than trusted to callers. */
            eq(accounts.status, "healthy"),
            isNull(accounts.deletedAt),
            /*
             * M13. This method currently has no callers, which is precisely why
             * these two lines matter: without them it is a correct-looking
             * helper that quietly ignores sellable slots and account expiry, and
             * the next person to reach for "give me available profiles" would
             * offer stock that does not exist.
             *
             * It deliberately does NOT implement the expired-allocation
             * recycling rule. That belongs to the allocation path, which holds
             * row locks while it decides; a read helper returning profiles that
             * still read `sold` would invite a caller to treat them as free
             * without taking one. Allocation goes through allocationRepository.
             */
            isSellableSlotSql,
            accountStillCoveredSql,
          ),
        )
        /* Highest health first — the Smart Stock Engine must never take the first match. */
        .orderBy(desc(accounts.healthScore), asc(profiles.profileNumber))
        .limit(limit);

      return rows.map((row) => row.profile);
    });
  },

  async findExpiringOnOrBefore(date) {
    return databaseAdapter.query("profiles.findExpiringOnOrBefore", (executor) =>
      executor
        .select()
        .from(profiles)
        .where(and(lte(profiles.expirationDate, date), eq(profiles.status, "sold")))
        .orderBy(asc(profiles.expirationDate)),
    );
  },

  async update(id, input) {
    const result = await databaseAdapter.query("profiles.update", (executor) =>
      executor
        .update(profiles)
        .set({ ...input, updatedAt: sql`now()` })
        .where(eq(profiles.id, id))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  async recordEvent(input) {
    const result = await databaseAdapter.query("profiles.recordEvent", (executor) =>
      executor.insert(profileEvents).values(input).returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Profile event", input.profileId);
  },

  async listEvents(profileId, pagination = {}) {
    const { limit, offset } = normalizePagination(pagination);
    const where = eq(profileEvents.profileId, profileId);

    return databaseAdapter.transaction("profiles.listEvents", async (executor) => {
      const items = await executor
        .select()
        .from(profileEvents)
        .where(where)
        .orderBy(desc(profileEvents.createdAt))
        .limit(limit)
        .offset(offset);

      const totals = await executor.select({ count: count() }).from(profileEvents).where(where);

      return { items, total: readCount(totals), limit, offset };
    });
  },

  async listAccountEvents(accountId, pagination = {}) {
    const { limit, offset } = normalizePagination(pagination);
    const where = eq(profileEvents.accountId, accountId);

    return databaseAdapter.transaction("profiles.listAccountEvents", async (executor) => {
      const items = await executor
        .select()
        .from(profileEvents)
        .where(where)
        .orderBy(desc(profileEvents.createdAt))
        .limit(limit)
        .offset(offset);

      const totals = await executor.select({ count: count() }).from(profileEvents).where(where);

      return { items, total: readCount(totals), limit, offset };
    });
  },

  /**
   * Profile count for an account.
   *
   * Exists so the five-profile invariant can be asserted after a migration or an
   * import, where rows may have arrived outside accountsRepository.create.
   */
  async countByAccount(accountId) {
    const result = await databaseAdapter.query("profiles.countByAccount", (executor) =>
      executor.select({ count: count() }).from(profiles).where(eq(profiles.accountId, accountId)),
    );

    if (!result.ok) {
      return result;
    }

    return ok(readCount(result.value));
  },

  async releaseSale(id, actorId) {
    return databaseAdapter.transaction("profiles.releaseSale", async (executor) => {
      /*
       * `for update` is what makes two admins safe.
       *
       * Both reach this line; the first takes the row lock and the second waits
       * on it. When the second proceeds it re-reads the row it just waited for
       * and sees `available`, so it returns `not_sold` rather than clearing an
       * allocation that has since been made again. Reading before locking would
       * let both pass the status check and the second would silently undo work
       * done between them.
       */
      const locked = await executor
        .select()
        .from(profiles)
        .where(eq(profiles.id, id))
        .for("update")
        .limit(1);

      const before = locked[0];

      if (!before) {
        return { outcome: "not_found" as const };
      }

      if (!HELD_STATUSES.includes(before.status)) {
        return { outcome: "not_sold" as const, current: before };
      }

      /*
       * The whole allocation, not the status alone. An `available` row that
       * still names a customer is refused by `profiles_held_requires_customer`,
       * and would double-sell if it were not.
       *
       * `profileNumber`, `accountId`, `profileName` and `pin` are deliberately
       * absent: the slot keeps its identity and its place on the account.
       */
      const updated = await executor
        .update(profiles)
        .set({
          status: "available",
          customerId: null,
          workerId: null,
          saleDate: null,
          expirationDate: null,
          durationDays: null,
          updatedAt: sql`now()`,
        })
        .where(eq(profiles.id, id))
        .returning();

      const after = updated[0];

      if (!after) {
        return { outcome: "not_found" as const };
      }

      /*
       * History, in the same transaction. `customer_changed` is the existing
       * label for an allocation moving off a profile — the enum has no
       * "unassigned", and 01_MASTER_RULES.md forbids inventing vocabulary. The
       * metadata says which sale ended and for whom, so the timeline can render
       * it without consulting a row that no longer holds any of it.
       */
      await executor.insert(profileEvents).values({
        accountId: before.accountId,
        profileId: before.id,
        eventType: "customer_changed",
        userId: actorId,
        customerId: before.customerId,
        metadata: {
          outcome: "sale_unassigned",
          profileNumber: before.profileNumber,
          previousStatus: before.status,
          previousCustomerId: before.customerId,
          previousSaleDate: before.saleDate,
          previousExpirationDate: before.expirationDate,
          previousDurationDays: before.durationDays,
        },
      });

      return { outcome: "released" as const, before, after };
    });
  },
};
