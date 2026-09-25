import "server-only";

import { PERMISSIONS, USER_ROLES, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { ForbiddenError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { evaluateAllocation } from "@/modules/accounts";
import { problemsService, type ProblemListEntry } from "@/modules/problems";
import { quickPrepareService } from "@/modules/quick-prepare";
import { usersService, type UserListEntry } from "@/modules/users";
import type { IssueRow } from "@/lib/drizzle/schema";
import {
  dashboardRepository,
  type ActivityRow,
  type BackupSummary,
  type DashboardCounts,
  type LabelledCount,
  type SeriesPoint,
} from "../repositories/dashboard.repository";
import { tallyAccountStates } from "./account-state-counts";
import { expirationBuckets, resellableExpired, tallyProfileStates } from "./profile-state-counts";
import { assessHealth, type HealthReport } from "./system-health";

/**
 * Dashboard service.
 *
 * Assembles the operational picture. Two rules shape it:
 *
 *   Nothing is duplicated. Presence comes from usersService, problems from
 *   problemsService, allocation from evaluateAllocation. This service reads
 *   aggregates the other modules have no reason to expose, and borrows
 *   everything else through their public APIs.
 *
 *   Workers see less. Administrative metrics — users, backups, system health —
 *   are omitted from the payload entirely rather than hidden in the markup. A
 *   number that never reaches the browser cannot be read out of it.
 */

export interface DashboardData {
  readonly counts: DashboardCounts;
  /** Present only for roles that may see administrative metrics. */
  /**
   * `null` for a role that may not see them; "error" when the backup read
   * failed. Health depends on that read, so it fails with it rather than
   * reporting "no backup" from data it never received.
   */
  readonly backups: BackupSummary | "error" | null;
  readonly health: HealthReport | "error" | null;
  /**
   * Who is online. `null` for a role that may not see it; "error" when the
   * read failed — never an empty list standing in for a failure.
   */
  readonly onlineUsers: readonly UserListEntry[] | "error" | null;
  /**
   * Each list is `null` when its read failed, so the widget can say so instead
   * of rendering "nothing here" for an outage.
   */
  readonly problems: {
    readonly newest: readonly ProblemListEntry[] | null;
    readonly critical: readonly ProblemListEntry[] | null;
    readonly waitingLongest: readonly ProblemListEntry[] | null;
    readonly assignedToMe: readonly ProblemListEntry[] | null;
    /** Raw rows: reopened problems are read straight from the aggregate query. */
    readonly reopened: readonly IssueRow[] | null;
  };
  /** Each series is `null` when its read failed — not an empty chart. */
  readonly charts: {
    readonly accountsOverTime: readonly SeriesPoint[] | null;
    readonly customersOverTime: readonly SeriesPoint[] | null;
    readonly problemsByType: readonly LabelledCount[] | null;
    readonly problemsBySeverity: readonly LabelledCount[] | null;
    readonly backupsOverTime: readonly SeriesPoint[] | null;
  };
  /** True when the caller may see users, backups and health. */
  readonly canSeeAdminMetrics: boolean;
}

function canSeeAdminMetrics(actor: AppUser): boolean {
  /*
   * One condition, not a role check scattered across widgets. Backups is the
   * narrowest administrative permission a Worker lacks, and 01_MASTER_RULES.md
   * groups exactly these under what a Worker may not see.
   */
  return roleHasPermission(actor.role, PERMISSIONS.ACCESS_BACKUPS);
}

/** A secondary read: its value, or null when it failed. */
function orNull<T>(result: Result<T>): T | null {
  return result.ok ? result.value : null;
}

/**
 * Everything the dashboard renders, in one call.
 *
 * Reads run in parallel. They are independent, and awaiting them in sequence
 * would make the page as slow as their sum rather than as slow as the slowest —
 * the difference between a dashboard that feels instant and one that does not.
 *
 * THE HEADLINE FIGURES ARE DERIVED, NOT COUNTED (M04). Accounts go through
 * `accountEffectiveStatus` and profiles through `profileCellState` — the same
 * functions behind every badge in the application — so a Healthy on the
 * dashboard is a Healthy on the Accounts page, and an Available here is an
 * Available there. If any of those reads fails, the whole overview fails:
 * zeros that look like real stock levels would be worse than an error.
 */
async function load(actor: AppUser | null): Promise<Result<DashboardData>> {
  if (!actor) {
    return fail(
      new ForbiddenError("No signed-in user for the dashboard", {
        userMessage: "Sign in to see the dashboard.",
      }),
    );
  }

  const isAdmin = canSeeAdminMetrics(actor);

  const [
    counts,
    accountStates,
    profileStates,
    backups,
    onlineUsers,
    newest,
    critical,
    waitingLongest,
    assignedToMe,
    reopened,
    accountsOverTime,
    customersOverTime,
    problemsByType,
    problemsBySeverity,
    backupsOverTime,
  ] = await Promise.all([
    dashboardRepository.counts(),
    dashboardRepository.accountStateInputs(),
    dashboardRepository.profileStateInputs(),
    isAdmin ? dashboardRepository.backupSummary() : Promise.resolve(null),
    isAdmin ? usersService.onlineNow(actor) : Promise.resolve(null),
    problemsService.list(
      { limit: 5, offset: 0, sortBy: "createdAt", sortDirection: "desc" },
      actor,
    ),
    problemsService.list({ limit: 5, offset: 0, severity: "critical", status: "open" }, actor),
    problemsService.list(
      { limit: 5, offset: 0, status: "waiting", sortBy: "updatedAt", sortDirection: "asc" },
      actor,
    ),
    problemsService.list({ limit: 5, offset: 0, assignedTo: actor.id }, actor),
    dashboardRepository.reopenedProblems(5),
    dashboardRepository.accountsCreatedByDay(30),
    dashboardRepository.customersCreatedByDay(30),
    dashboardRepository.problemsByType(),
    dashboardRepository.problemsBySeverity(),
    isAdmin ? dashboardRepository.backupsByDay(30) : Promise.resolve(null),
  ]);

  if (!counts.ok) {
    return counts;
  }

  if (!accountStates.ok) {
    return accountStates;
  }

  if (!profileStates.ok) {
    return profileStates;
  }

  /*
   * Blocking problem types per account, from the Problems module's public API
   * — the same call, with the same answer, that the Accounts list makes before
   * it derives each row's status. One query for every account.
   */
  const problemTypes = await problemsService.accountsWithActiveProblems(
    accountStates.value.map((row) => row.id),
  );

  if (!problemTypes.ok) {
    return problemTypes;
  }

  /* One clock for the whole page, so no two figures straddle midnight. */
  const today = new Date();

  const accountTally = tallyAccountStates(
    accountStates.value.map((row) => ({
      account: row,
      blockingProblemTypes: problemTypes.value.get(row.id) ?? [],
    })),
    today,
  );

  const profileTally = tallyProfileStates(profileStates.value, today);

  const dashboardCounts: DashboardCounts = {
    ...counts.value,
    accounts: accountTally,
    profiles: {
      total: profileStates.value.length,
      available: profileTally.available,
      sold: profileTally.sold,
      expiringSoon: profileTally.expiring_soon,
      expired: profileTally.expired,
      blocked: profileTally.blocked,
      notForSale: profileTally.not_for_sale,
      resellableExpired: resellableExpired(profileStates.value, today),
    },
    expirations: expirationBuckets(profileStates.value, today),
  };

  const backupSummary = backups && backups.ok ? backups.value : null;
  const backupReadFailed = backups !== null && !backups.ok;

  /*
   * Health is computed from measured facts, never assumed. `databaseReachable`
   * is true only because the counts query above succeeded — if it had failed,
   * this function returned already.
   */
  const health: HealthReport | "error" | null = !isAdmin
    ? null
    : backupReadFailed
      ? "error"
      : assessHealth(
          {
            criticalProblems: counts.value.problems.critical,
            failedBackups: backupSummary?.failed ?? 0,
            lastBackupAt: backupSummary?.lastBackupAt ?? null,
            lastChecksumVerified: backupSummary?.lastChecksumVerified ?? false,
            databaseReachable: true,
          },
          today,
        );

  const list = (result: Awaited<ReturnType<typeof problemsService.list>>) =>
    result.ok ? result.value.items : null;

  return ok({
    counts: dashboardCounts,
    backups: !isAdmin ? null : backupReadFailed ? "error" : backupSummary,
    health,
    onlineUsers: onlineUsers === null ? null : onlineUsers.ok ? onlineUsers.value : "error",
    problems: {
      newest: list(newest),
      critical: list(critical),
      waitingLongest: list(waitingLongest),
      assignedToMe: list(assignedToMe),
      reopened: orNull(reopened),
    },
    charts: {
      accountsOverTime: orNull(accountsOverTime),
      customersOverTime: orNull(customersOverTime),
      problemsByType: orNull(problemsByType),
      problemsBySeverity: orNull(problemsBySeverity),
      backupsOverTime: backupsOverTime === null ? [] : orNull(backupsOverTime),
    },
    canSeeAdminMetrics: isAdmin,
  });
}

/**
 * The activity feed, paginated.
 *
 * Separate from `load` because the feed pages independently — scrolling it must
 * not re-run every aggregate on the page.
 */
async function activity(
  actor: AppUser | null,
  limit: number,
  offset: number,
): Promise<Result<readonly ActivityRow[]>> {
  if (!actor) {
    return fail(new ForbiddenError("No signed-in user for the activity feed"));
  }

  /*
   * Login history and audit entries name people and describe administrative
   * actions, so the merged feed is administrative. A Worker sees the profile
   * events only.
   */
  if (!canSeeAdminMetrics(actor)) {
    return dashboardRepository.recentProfileActivity(limit, offset);
  }

  return dashboardRepository.recentActivity(limit, offset);
}

/** Below this many allocatable profiles, the widget warns. */
export const LOW_STOCK_THRESHOLD = 5;

export interface StockEntry {
  readonly accountId: string;
  readonly email: string;
  readonly allocatable: number;
  readonly total: number;
}

export interface StockSummary {
  readonly top: readonly StockEntry[];
  readonly almostFull: readonly StockEntry[];
  /** Quick Prepare's own count — `quickPrepareService.availableStock`. */
  readonly totalAllocatable: number;
  readonly lowStock: boolean;
  readonly excludedForProblems: number;
}

/** Accounts the per-account breakdown considers. The total never depends on it. */
const STOCK_CANDIDATE_LIMIT = 200;

/**
 * Stock summary.
 *
 * Availability is counted by running each profile through
 * `evaluateAllocation` — the same function Quick Prepare and the account screen
 * use. The M09 brief requires reusing it, and the reason is more than tidiness:
 * a second definition of "allocatable" on the dashboard would eventually
 * disagree with the one that actually allocates, and the widget would advertise
 * stock the engine refuses.
 *
 * Problem accounts drop out automatically, because that rule now lives inside
 * `evaluateAllocation` too.
 */
async function stock(actor: AppUser | null): Promise<Result<StockSummary>> {
  if (!actor) {
    return fail(new ForbiddenError("No signed-in user for the stock widget"));
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.VIEW_ACCOUNTS)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not view stock`, {
        userMessage: "You do not have permission to view accounts.",
      }),
    );
  }

  /*
   * The total is Quick Prepare's own figure, not a sum computed here: the
   * widget's headline is the number the allocator will actually sell from.
   * The per-account breakdown below still runs evaluateAllocation, the same
   * rule, over the same accounts.
   */
  const [candidates, available] = await Promise.all([
    dashboardRepository.stockCandidates(STOCK_CANDIDATE_LIMIT),
    quickPrepareService.availableStock(),
  ]);

  if (!candidates.ok) {
    return candidates;
  }

  if (!available.ok) {
    return available;
  }

  let excludedForProblems = 0;

  /* One clock for the whole snapshot, so no two accounts straddle midnight. */
  const today = new Date();

  const entries: StockEntry[] = candidates.value.map((candidate) => {
    if (candidate.hasActiveProblem) {
      excludedForProblems += 1;
    }

    const allocatable = candidate.profiles.filter(
      (profile) =>
        /*
         * No requestedDurationDays: the dashboard reports stock on hand, not
         * stock for a particular sale. Since M13 this count also excludes
         * not-for-sale slots and expired accounts, and includes profiles whose
         * customer has expired — all through the one shared rule.
         */
        evaluateAllocation(candidate.account, profile, {
          hasActiveProblem: candidate.hasActiveProblem,
          today,
        }).isAllocatable,
    ).length;

    return {
      accountId: candidate.account.id,
      email: candidate.account.email,
      allocatable,
      total: candidate.profiles.length,
    };
  });

  const withStock = entries.filter((entry) => entry.allocatable > 0);
  const totalAllocatable = available.value;

  return ok({
    top: [...withStock].sort((a, b) => b.allocatable - a.allocatable).slice(0, 5),
    /* One profile left. The next sale takes the account out of circulation. */
    almostFull: entries.filter((entry) => entry.allocatable === 1).slice(0, 5),
    totalAllocatable,
    lowStock: totalAllocatable < LOW_STOCK_THRESHOLD,
    excludedForProblems,
  });
}

export const dashboardService = {
  load,
  activity,
  stock,
  isSuperAdmin: (actor: AppUser) => actor.role === USER_ROLES.SUPER_ADMIN,
} as const;
