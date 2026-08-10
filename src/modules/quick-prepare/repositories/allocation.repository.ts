import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { databaseAdapter, type DatabaseExecutor } from "@/lib/database";
import { accounts, issues, profiles, type AccountRow, type ProfileRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";

/**
 * Allocation repository.
 *
 * Belongs to quick-prepare rather than to accounts because the read it performs
 * is unlike anything the accounts module needs: a ranked, locked scan across two
 * tables, run inside someone else's transaction.
 *
 * Tables are not owned by modules — the schema is shared infrastructure — so
 * this is not a cross-module dependency. ADR-003's rule is about importing
 * another module's code, which this does not do.
 */

/** An account with its free profiles, ready to be scored. */
export interface AllocationCandidate {
  readonly account: AccountRow;
  readonly availableProfiles: readonly ProfileRow[];
  /** Profiles already sold on this account. Drives the anti-fragmentation preference. */
  readonly soldCount: number;
}

/**
 * The eligibility rule, in one place.
 *
 * 01_MASTER_RULES.md: only Healthy accounts, only Available profiles, ignore
 * archived, deleted and anything with a problem.
 *
 * `status = 'healthy'` covers every exclusion at once: archived, deleted,
 * payment_problem, incorrect_password, invalid_email and something_went_wrong
 * are all separate values of the same enum. Listing them individually would go
 * stale the moment a status is added.
 */
/**
 * No open problem is blocking the account.
 *
 * M08. Expressed in SQL rather than filtered afterwards, deliberately: the
 * locking read below takes row locks with SKIP LOCKED, and filtering after the
 * fact would lock profiles this engine then discards — holding stock nobody can
 * allocate until the transaction ends. The count query would be wrong too.
 *
 * This reads the `issues` table through the shared schema, which ADR-005
 * Decision 5 permits a repository to do. It is not a module dependency —
 * importing the Problems module's constant here would be, since ADR-003 forbids
 * a repository importing another module.
 *
 * The status list is therefore written out rather than imported, and a unit
 * test asserts it matches BLOCKING_STATUSES exactly. The duplication is real;
 * the test is what stops it drifting, the same technique used for APP_VERSION.
 */
const noBlockingProblem = sql`not exists (
  select 1 from ${issues}
  where ${issues.accountId} = ${accounts.id}
    and ${issues.status} in ('open', 'in_progress', 'waiting')
)`;

/**
 * The eligibility rule, in one place.
 *
 * Both the preview and the locking read use this, so Quick Prepare cannot offer
 * a profile the confirmation step would refuse.
 */
const eligibleAccount = and(
  eq(accounts.status, "healthy"),
  isNull(accounts.deletedAt),
  noBlockingProblem,
);

/**
 * Reads candidates without locking. Preview only.
 *
 * ADR-007 Decision 4: the preview is advisory. Taking locks here would hold them
 * across the worker's thinking time, and abandoning the tab would strand stock.
 */
async function findCandidates(limit = 40): Promise<Result<readonly AllocationCandidate[]>> {
  return databaseAdapter.query("allocation.findCandidates", async (executor) =>
    readCandidates(executor, limit, false),
  );
}

/**
 * Reads and LOCKS candidates. Confirmation only.
 *
 * Must be called inside a transaction. The lock is held until that transaction
 * commits, which is what makes "check availability then allocate" atomic — the
 * profiles cannot be taken between the two steps.
 *
 * SKIP LOCKED is the important part. Without it, two workers confirming at the
 * same moment queue on the same rows and the second waits for the first to
 * finish before discovering the stock is gone. With it, the second immediately
 * sees different stock and serves its customer.
 */
async function lockCandidates(
  executor: DatabaseExecutor,
  limit = 40,
): Promise<readonly AllocationCandidate[]> {
  return readCandidates(executor, limit, true);
}

async function readCandidates(
  executor: DatabaseExecutor,
  limit: number,
  lock: boolean,
): Promise<readonly AllocationCandidate[]> {
  /*
   * Two queries rather than one join.
   *
   * FOR UPDATE cannot be combined with the aggregate needed for the sold count,
   * and locking an aggregated result set is not meaningful anyway. The profile
   * rows are what must be locked, so they are fetched and locked directly.
   */
  const profileRows = lock
    ? await executor
        .select({ profile: profiles, account: accounts })
        .from(profiles)
        .innerJoin(accounts, eq(profiles.accountId, accounts.id))
        .where(and(eq(profiles.status, "available"), eligibleAccount))
        .orderBy(desc(accounts.healthScore), asc(accounts.createdAt), asc(profiles.profileNumber))
        .limit(limit * 5)
        /* Lock the profile rows only; the account row is read for context. */
        .for("update", { of: profiles, skipLocked: true })
    : await executor
        .select({ profile: profiles, account: accounts })
        .from(profiles)
        .innerJoin(accounts, eq(profiles.accountId, accounts.id))
        .where(and(eq(profiles.status, "available"), eligibleAccount))
        .orderBy(desc(accounts.healthScore), asc(accounts.createdAt), asc(profiles.profileNumber))
        .limit(limit * 5);

  if (profileRows.length === 0) {
    return [];
  }

  const accountIds = [...new Set(profileRows.map((row) => row.account.id))];

  /*
   * Sold counts for exactly the accounts in play. Counting every account in the
   * table would scale with the whole database rather than with the request.
   */
  const soldCounts = await executor
    .select({
      accountId: profiles.accountId,
      soldCount: sql<number>`count(*) filter (where ${profiles.status} = 'sold')::int`,
    })
    .from(profiles)
    .where(sql`${profiles.accountId} in ${accountIds}`)
    .groupBy(profiles.accountId);

  const soldByAccount = new Map(soldCounts.map((row) => [row.accountId, row.soldCount]));

  const grouped = new Map<string, { account: AccountRow; availableProfiles: ProfileRow[] }>();

  for (const row of profileRows) {
    const entry = grouped.get(row.account.id) ?? {
      account: row.account,
      availableProfiles: [],
    };

    entry.availableProfiles.push(row.profile);
    grouped.set(row.account.id, entry);
  }

  return [...grouped.values()].map((entry) => ({
    account: entry.account,
    availableProfiles: entry.availableProfiles,
    soldCount: soldByAccount.get(entry.account.id) ?? 0,
  }));
}

/** Total profiles allocatable right now. Powers the "not enough stock" message. */
async function countAvailable(): Promise<Result<number>> {
  return databaseAdapter.query("allocation.countAvailable", async (executor) => {
    const rows = await executor
      .select({ total: sql<number>`count(*)::int` })
      .from(profiles)
      .innerJoin(accounts, eq(profiles.accountId, accounts.id))
      .where(and(eq(profiles.status, "available"), eligibleAccount));

    return rows[0]?.total ?? 0;
  });
}

export const allocationRepository = {
  findCandidates,
  lockCandidates,
  countAvailable,
} as const;
