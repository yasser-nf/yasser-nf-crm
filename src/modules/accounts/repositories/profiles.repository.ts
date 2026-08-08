import { and, asc, count, desc, eq, isNull, lte, sql } from "drizzle-orm";

import {
  databaseAdapter,
  normalizePagination,
  readCount,
  requireFound,
  type Page,
  type PaginationInput,
} from "@/lib/database";
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
}

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
};
