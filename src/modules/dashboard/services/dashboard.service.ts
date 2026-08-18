import "server-only";

import { PERMISSIONS, USER_ROLES, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { ForbiddenError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { evaluateAllocation } from "@/modules/accounts";
import { problemsService, type ProblemListEntry } from "@/modules/problems";
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
  readonly backups: BackupSummary | null;
  readonly health: HealthReport | null;
  readonly onlineUsers: readonly UserListEntry[] | null;
  readonly problems: {
    readonly newest: readonly ProblemListEntry[];
    readonly critical: readonly ProblemListEntry[];
    readonly waitingLongest: readonly ProblemListEntry[];
    readonly assignedToMe: readonly ProblemListEntry[];
    /** Raw rows: reopened problems are read straight from the aggregate query. */
    readonly reopened: readonly IssueRow[];
  };
  readonly charts: {
    readonly accountsOverTime: readonly SeriesPoint[];
    readonly customersOverTime: readonly SeriesPoint[];
    readonly problemsBySeverity: readonly LabelledCount[];
    readonly backupsOverTime: readonly SeriesPoint[];
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

/**
 * Everything the dashboard renders, in one call.
 *
 * Reads run in parallel. They are independent, and awaiting them in sequence
 * would make the page as slow as their sum rather than as slow as the slowest —
 * the difference between a dashboard that feels instant and one that does not.
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
    backups,
    onlineUsers,
    newest,
    critical,
    waitingLongest,
    assignedToMe,
    reopened,
    accountsOverTime,
    customersOverTime,
    problemsBySeverity,
    backupsOverTime,
  ] = await Promise.all([
    dashboardRepository.counts(),
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
    dashboardRepository.problemsBySeverity(),
    isAdmin ? dashboardRepository.backupsByDay(30) : Promise.resolve(null),
  ]);

  if (!counts.ok) {
    return counts;
  }

  const backupSummary = backups && backups.ok ? backups.value : null;

  /*
   * Health is computed from measured facts, never assumed. `databaseReachable`
   * is true only because the counts query above succeeded — if it had failed,
   * this function returned already.
   */
  const health: HealthReport | null = isAdmin
    ? assessHealth(
        {
          criticalProblems: counts.value.problems.critical,
          failedBackups: backupSummary?.failed ?? 0,
          lastBackupAt: backupSummary?.lastBackupAt ?? null,
          lastChecksumVerified: backupSummary?.lastChecksumVerified ?? false,
          databaseReachable: true,
        },
        new Date(),
      )
    : null;

  const list = (result: Awaited<ReturnType<typeof problemsService.list>>) =>
    result.ok ? result.value.items : [];

  return ok({
    counts: counts.value,
    backups: backupSummary,
    health,
    onlineUsers: onlineUsers && onlineUsers.ok ? onlineUsers.value : null,
    problems: {
      newest: list(newest),
      critical: list(critical),
      waitingLongest: list(waitingLongest),
      assignedToMe: list(assignedToMe),
      reopened: reopened.ok ? reopened.value : [],
    },
    charts: {
      accountsOverTime: accountsOverTime.ok ? accountsOverTime.value : [],
      customersOverTime: customersOverTime.ok ? customersOverTime.value : [],
      problemsBySeverity: problemsBySeverity.ok ? problemsBySeverity.value : [],
      backupsOverTime: backupsOverTime && backupsOverTime.ok ? backupsOverTime.value : [],
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
  readonly healthScore: number;
  readonly allocatable: number;
  readonly total: number;
}

export interface StockSummary {
  readonly top: readonly StockEntry[];
  readonly almostFull: readonly StockEntry[];
  readonly totalAllocatable: number;
  readonly lowStock: boolean;
  readonly excludedForProblems: number;
}

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

  const candidates = await dashboardRepository.stockCandidates(25);

  if (!candidates.ok) {
    return candidates;
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
      healthScore: candidate.account.healthScore,
      allocatable,
      total: candidate.profiles.length,
    };
  });

  const withStock = entries.filter((entry) => entry.allocatable > 0);
  const totalAllocatable = withStock.reduce((sum, entry) => sum + entry.allocatable, 0);

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
