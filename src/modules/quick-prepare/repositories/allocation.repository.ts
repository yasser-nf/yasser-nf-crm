import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { databaseAdapter, type DatabaseExecutor } from "@/lib/database";
import {
  accountCanAllocateSql,
  isSellableSlotSql,
  profileIsFreeSql,
} from "@/lib/drizzle/predicates";
import { accounts, profiles, type AccountRow, type ProfileRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import { ok } from "@/utils/result";

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
  /**
   * Days left on the account's own coverage. Null means open-ended.
   *
   * Computed here, in SQL, rather than in the engine. The engine is pure and
   * has no clock; handing it a number keeps it that way, and keeps "today" a
   * single value decided by the database for the whole query instead of one
   * `new Date()` per candidate.
   */
  readonly remainingValidityDays: number | null;
}

/**
 * The eligibility rule, in one place — now `lib/drizzle/predicates`.
 *
 * 01_MASTER_RULES.md: only Healthy accounts, only Available profiles, ignore
 * archived, deleted and anything with a problem. `status = 'healthy'` covers
 * most of those at once, because archived, deleted, payment_problem,
 * incorrect_password, invalid_email and something_went_wrong are all separate
 * values of the same enum — listing them individually would go stale the moment
 * a status is added. The open-problem check is the part the enum cannot express.
 *
 * Both the preview and the locking read use this, so Quick Prepare cannot offer
 * a profile the confirmation step would refuse.
 *
 * It used to be composed here, and this was the only place in the codebase that
 * knew an open problem should withhold an account's stock. The accounts list and
 * the dashboard counted the same profiles as available, so the two disagreed:
 * the dashboard advertised four profiles on an account this engine would never
 * select. Moving the rule to the shared predicate module is what makes that
 * disagreement impossible rather than merely fixed once.
 *
 * The rule is expressed in SQL rather than filtered afterwards, deliberately:
 * the locking read below takes row locks with SKIP LOCKED, and filtering after
 * the fact would lock profiles this engine then discards — holding stock nobody
 * can allocate until the transaction ends. The count query would be wrong too.
 *
 * `accountStillCoveredSql` inside it is the hard cut only. It removes accounts
 * that can serve NOBODY. Whether an account has enough time left for a
 * PARTICULAR request is a different question, decided by the engine against the
 * requested duration, so that a rejection can say "18 days remaining, 90
 * requested" instead of silently returning nothing.
 */
const eligibleAccount = accountCanAllocateSql;

/**
 * A profile row that can be sold right now.
 *
 * Both halves come from lib/drizzle/predicates so the accounts list, the
 * dashboard and the reports aggregates apply the identical rule — M13 §11
 * requires these enforced centrally, and six copies of a WHERE clause is the
 * duplication that requirement exists to prevent.
 *
 * Expressed in SQL rather than filtered afterwards, for the same reason the
 * problem check is: the locking read takes row locks with SKIP LOCKED, and
 * filtering after the fact would lock rows this engine then discards, holding
 * stock nobody can allocate until the transaction ends.
 */
const allocatableProfile = and(isSellableSlotSql, profileIsFreeSql);

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
        .select({
          profile: profiles,
          account: accounts,
          /* Null stays null: open-ended coverage, not zero days left. */
          remainingValidityDays: sql<number | null>`(${accounts.validUntil} - current_date)::int`,
        })
        .from(profiles)
        .innerJoin(accounts, eq(profiles.accountId, accounts.id))
        .where(and(allocatableProfile, eligibleAccount))
        .orderBy(desc(accounts.healthScore), asc(accounts.createdAt), asc(profiles.profileNumber))
        .limit(limit * 5)
        /* Lock the profile rows only; the account row is read for context. */
        .for("update", { of: profiles, skipLocked: true })
    : await executor
        .select({
          profile: profiles,
          account: accounts,
          /* Null stays null: open-ended coverage, not zero days left. */
          remainingValidityDays: sql<number | null>`(${accounts.validUntil} - current_date)::int`,
        })
        .from(profiles)
        .innerJoin(accounts, eq(profiles.accountId, accounts.id))
        .where(and(allocatableProfile, eligibleAccount))
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

  const grouped = new Map<
    string,
    {
      account: AccountRow;
      availableProfiles: ProfileRow[];
      remainingValidityDays: number | null;
    }
  >();

  for (const row of profileRows) {
    const entry = grouped.get(row.account.id) ?? {
      account: row.account,
      availableProfiles: [],
      remainingValidityDays: row.remainingValidityDays,
    };

    entry.availableProfiles.push(row.profile);
    grouped.set(row.account.id, entry);
  }

  return [...grouped.values()].map((entry) => ({
    account: entry.account,
    availableProfiles: entry.availableProfiles,
    soldCount: soldByAccount.get(entry.account.id) ?? 0,
    remainingValidityDays: entry.remainingValidityDays,
  }));
}

/** Total profiles allocatable right now. Powers the "not enough stock" message. */
async function countAvailable(): Promise<Result<number>> {
  return databaseAdapter.query("allocation.countAvailable", async (executor) => {
    const rows = await executor
      .select({ total: sql<number>`count(*)::int` })
      .from(profiles)
      .innerJoin(accounts, eq(profiles.accountId, accounts.id))
      .where(and(allocatableProfile, eligibleAccount));

    return rows[0]?.total ?? 0;
  });
}

/**
 * Which of these accounts have ever carried an allocation that has since lapsed.
 *
 * M13 §7: an account whose previous customer expired must have its password
 * changed before it is handed to somebody new — the old customer still knows the
 * credentials. This is the query that detects it.
 *
 * Read from the DATE, not from `profiles.status`: nothing writes `expired`, so a
 * status check would report "no reuse" forever.
 *
 * Batched deliberately. The preview asks about every candidate account at once,
 * and one query for a page beats one per account.
 */
async function accountsNeedingPasswordChange(
  accountIds: readonly string[],
): Promise<Result<ReadonlySet<string>>> {
  if (accountIds.length === 0) {
    return ok(new Set());
  }

  const rows = await databaseAdapter.query("allocation.reuseCheck", async (executor) =>
    executor
      .selectDistinct({ accountId: profiles.accountId })
      .from(profiles)
      .where(
        and(
          inArray(profiles.accountId, [...accountIds]),
          sql`${profiles.expirationDate} is not null and ${profiles.expirationDate} < current_date`,
        ),
      ),
  );

  if (!rows.ok) {
    return rows;
  }

  return ok(new Set(rows.value.map((row) => row.accountId)));
}

export const allocationRepository = {
  findCandidates,
  lockCandidates,
  countAvailable,
  accountsNeedingPasswordChange,
} as const;
