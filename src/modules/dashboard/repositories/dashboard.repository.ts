import { and, asc, eq, getTableColumns, inArray, ne, sql } from "drizzle-orm";

import { databaseAdapter } from "@/lib/database";
import {
  accountHasNoBlockingProblemSql,
  accountIsLiveSql,
  rawAccountIsLive,
} from "@/lib/drizzle/predicates";
import {
  accounts,
  issues,
  profiles,
  type AccountRow,
  type IssueRow,
  type ProfileRow,
} from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";

/**
 * Dashboard repository.
 *
 * The M09 performance rule: the dashboard must not run fifty independent
 * queries. It runs **four**, and each one aggregates a whole domain in a single
 * round trip using `filter (where …)` — PostgreSQL counts every bucket in one
 * pass over the table rather than once per bucket.
 *
 * Written as aggregate SQL rather than as repeated `select count(*)` calls
 * through the other modules' repositories. Those repositories answer "give me
 * these rows"; a dashboard asks "how many, by category", which is a different
 * question and would be N+1 if expressed with the first one.
 *
 * Every value here is counted from the live tables. Nothing is stored, cached
 * or precomputed, so no number on this screen can disagree with the data it
 * describes.
 */

export interface AccountCounts {
  /** Live accounts (not soft-deleted). Equals healthy + problems + expired + archived. */
  readonly total: number;
  readonly healthy: number;
  readonly problems: number;
  readonly expired: number;
  readonly archived: number;
}

/**
 * Profile figures, every one a `profileCellState` bucket (M01.5, M04).
 *
 * available + sold + expiringSoon + expired + blocked + notForSale = total —
 * disjoint by construction. There is no `reserved`: nothing writes it, and
 * `profileCellState` already counts a reserved row as held (sold / expiring
 * soon), so showing it separately would have counted one profile twice.
 */
export interface ProfileCounts {
  readonly total: number;
  readonly available: number;
  readonly sold: number;
  readonly expiringSoon: number;
  readonly expired: number;
  /** Free, but the account cannot sell it: a problem, a fault or expired validity. */
  readonly blocked: number;
  /** Above the account's profile_slots. Not stock. M13. */
  readonly notForSale: number;
  /**
   * Expired allocations Quick Prepare may resell now (the recycling rule).
   * Already inside `expired`; carried so the stock figure can be explained.
   */
  readonly resellableExpired: number;
}

/** What `counts()` returns: the figures SQL states on its own. */
export interface RepositoryCounts {
  readonly customers: CustomerCounts;
  readonly problems: ProblemCounts;
  readonly users: UserCounts;
  readonly prepared: PreparedCounts;
}

/** A live account with exactly the facts `accountEffectiveStatus` reads. */
export interface AccountStateRow {
  readonly id: string;
  readonly status: AccountRow["status"];
  readonly validUntil: AccountRow["validUntil"];
  readonly deletedAt: AccountRow["deletedAt"];
}

/** One profile, with exactly the account facts `profileCellState` needs. */
export interface ProfileStateRow {
  readonly profile: ProfileRow;
  readonly account: Pick<AccountRow, "profileSlots" | "validUntil" | "status" | "deletedAt">;
  readonly hasBlockingProblem: boolean;
}

export interface CustomerCounts {
  readonly total: number;
  readonly active: number;
  readonly blocked: number;
  readonly archived: number;
}

/**
 * Problem figures, counted from `issues` on LIVE accounts (M04).
 *
 * Problem RECORDS and the ACCOUNTS they affect are different numbers: one
 * account with three open problems is 3 blocking problems and 1 affected
 * account. Problems on soft-deleted accounts are left out — the account no
 * longer exists anywhere else on this page.
 */
export interface ProblemCounts {
  readonly open: number;
  readonly waiting: number;
  readonly inProgress: number;
  /** open + in progress + waiting — BLOCKING_STATUSES. */
  readonly blocking: number;
  /** Distinct accounts with at least one blocking problem. */
  readonly accountsAffected: number;
  /** Blocking problems of type payment_problem, and the accounts they sit on. */
  readonly paymentProblems: number;
  readonly paymentProblemAccounts: number;
  readonly resolvedToday: number;
  /** Blocking and stored as critical. Historical since M03: new problems store `medium`. */
  readonly critical: number;
}

export interface UserCounts {
  readonly active: number;
  readonly suspended: number;
  readonly disabled: number;
}

export interface BackupSummary {
  readonly lastBackupAt: Date | null;
  readonly lastSnapshotAt: Date | null;
  readonly failed: number;
  readonly lastChecksumVerified: boolean;
  readonly lastSizeBytes: number | null;
  readonly lastDurationMs: number | null;
}

export interface PreparedCounts {
  readonly today: number;
  readonly yesterday: number;
  readonly thisWeek: number;
  readonly thisMonth: number;
}

/** Disjoint — see `expirationBuckets` in services/profile-state-counts. */
export interface ExpirationBuckets {
  readonly expired: number;
  readonly today: number;
  readonly tomorrow: number;
  readonly inTwoToThree: number;
  readonly inFourToSeven: number;
}

export interface DashboardCounts {
  readonly accounts: AccountCounts;
  readonly profiles: ProfileCounts;
  readonly customers: CustomerCounts;
  readonly problems: ProblemCounts;
  readonly users: UserCounts;
  readonly prepared: PreparedCounts;
  readonly expirations: ExpirationBuckets;
}

function readNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function readDate(row: Record<string, unknown>, key: string): Date | null {
  const value = row[key];

  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface DashboardRepository {
  /** Every KPI SQL can state on its own, in one round trip per domain group. */
  counts(): Promise<Result<RepositoryCounts>>;
  /** Every live account's status and validity, for `accountEffectiveStatus`. */
  accountStateInputs(): Promise<Result<readonly AccountStateRow[]>>;
  /**
   * Every profile on a live account, with the account facts the display rule
   * reads. The service turns these into the Profiles widget's figures through
   * `profileCellState` — the one definition of what a profile is showing.
   */
  profileStateInputs(): Promise<Result<readonly ProfileStateRow[]>>;
  backupSummary(): Promise<Result<BackupSummary>>;
  /** Newest first, merged across the three history sources. */
  recentActivity(limit: number, offset: number): Promise<Result<readonly ActivityRow[]>>;
  /** Profile events only — the non-administrative slice, for Workers. */
  recentProfileActivity(limit: number, offset: number): Promise<Result<readonly ActivityRow[]>>;
  /** Problems that have come back, most-reopened first. */
  reopenedProblems(limit: number): Promise<Result<readonly IssueRow[]>>;
  /** Candidate accounts with their profiles, for the stock widget. */
  stockCandidates(limit: number): Promise<Result<readonly StockCandidate[]>>;
  accountsCreatedByDay(days: number): Promise<Result<readonly SeriesPoint[]>>;
  customersCreatedByDay(days: number): Promise<Result<readonly SeriesPoint[]>>;
  problemsBySeverity(): Promise<Result<readonly LabelledCount[]>>;
  /** Blocking problems on live accounts, by type — the attribute the workflow uses. */
  problemsByType(): Promise<Result<readonly LabelledCount[]>>;
  backupsByDay(days: number): Promise<Result<readonly SeriesPoint[]>>;
}

export interface ActivityRow {
  readonly id: string;
  readonly source: "audit" | "profile" | "auth";
  readonly action: string;
  readonly entity: string | null;
  readonly actorName: string | null;
  readonly createdAt: Date;
}

export interface SeriesPoint {
  readonly day: string;
  readonly count: number;
}

/**
 * An account and its profiles, for the stock widget.
 *
 * Returns rows rather than counts on purpose: the service passes each profile
 * through `evaluateAllocation`, so the allocation rule has exactly one
 * definition. Counting availability in SQL here would be a second one, and the
 * two would eventually disagree.
 *
 * Bounded by `limit`, so this is tens of rows — not a scan of every account.
 */
export interface StockCandidate {
  readonly account: AccountRow;
  readonly profiles: readonly ProfileRow[];
  readonly hasActiveProblem: boolean;
}

export interface LabelledCount {
  readonly label: string;
  readonly count: number;
}

export const dashboardRepository: DashboardRepository = {
  async counts() {
    return databaseAdapter.query("dashboard.counts", async (executor) => {
      /*
       * Four statements, one aggregate each. Accounts and profiles are no
       * longer counted here: their buckets are display states, whose only
       * correct definitions (`accountEffectiveStatus`, `profileCellState`)
       * live in TypeScript. See the service.
       *
       * Day boundaries are UTC, stated explicitly with the three-argument
       * `date_trunc(field, timestamptz, 'UTC')`, rather than taken from the
       * session's time zone — the application's own date rules are UTC, and a
       * session in another zone would otherwise move midnight.
       */
      const customerRows = await executor.execute(sql`
        select
          count(*)::int as total,
          count(*) filter (where blocked_at is not null and deleted_at is null)::int as blocked,
          count(*) filter (where deleted_at is not null)::int as archived,
          /*
           * Active means "holds at least one live subscription", the same rule
           * customer-status.ts derives. Expressed here as an EXISTS so the
           * dashboard does not load every customer to count them.
           */
          count(*) filter (
            where deleted_at is null
              and blocked_at is null
              and exists (
                select 1 from profiles p
                where p.customer_id = customers.id
                  and p.status in ('sold', 'expiring_soon')
                  and (p.expiration_date is null
                       or p.expiration_date >= (now() at time zone 'UTC')::date)
              )
          )::int as active
        from customers
      `);

      /*
       * On live accounts only — the same scope as every other figure here.
       * Records and affected accounts are counted separately on purpose.
       */
      const problemRows = await executor.execute(sql`
        select
          count(*) filter (where i.status = 'open')::int as open,
          count(*) filter (where i.status = 'waiting')::int as waiting,
          count(*) filter (where i.status = 'in_progress')::int as in_progress,
          count(*) filter (where i.status in ('open', 'in_progress', 'waiting'))::int as blocking,
          count(distinct i.account_id) filter (
            where i.status in ('open', 'in_progress', 'waiting')
          )::int as accounts_affected,
          count(*) filter (
            where i.status in ('open', 'in_progress', 'waiting') and i.issue_type = 'payment_problem'
          )::int as payment_problems,
          count(distinct i.account_id) filter (
            where i.status in ('open', 'in_progress', 'waiting') and i.issue_type = 'payment_problem'
          )::int as payment_problem_accounts,
          count(*) filter (
            where i.status = 'resolved' and i.resolved_at >= date_trunc('day', now(), 'UTC')
          )::int as resolved_today,
          count(*) filter (
            where i.severity = 'critical' and i.status in ('open', 'in_progress', 'waiting')
          )::int as critical
        from issues i
        join accounts a on a.id = i.account_id
        where ${rawAccountIsLive("a")}
      `);

      const userRows = await executor.execute(sql`
        select
          count(*) filter (where status = 'active' and deleted_at is null)::int as active,
          count(*) filter (where status = 'suspended' and deleted_at is null)::int as suspended,
          count(*) filter (where status = 'disabled' and deleted_at is null)::int as disabled
        from users
      `);

      /*
       * Quick Prepare volume comes from profile_events, the only record of a
       * sale. Counting profiles.sale_date instead would miss a profile that was
       * later replaced or expired. UTC days, ISO weeks (Monday), UTC months.
       */
      const preparedRows = await executor.execute(sql`
        select
          count(*) filter (where created_at >= date_trunc('day', now(), 'UTC'))::int as today,
          count(*) filter (
            where created_at >= date_trunc('day', now(), 'UTC') - interval '1 day'
              and created_at < date_trunc('day', now(), 'UTC')
          )::int as yesterday,
          count(*) filter (where created_at >= date_trunc('week', now(), 'UTC'))::int as this_week,
          count(*) filter (where created_at >= date_trunc('month', now(), 'UTC'))::int as this_month
        from profile_events
        where event_type = 'sold'
      `);

      const customer = (customerRows as unknown as Record<string, unknown>[])[0] ?? {};
      const problem = (problemRows as unknown as Record<string, unknown>[])[0] ?? {};
      const user = (userRows as unknown as Record<string, unknown>[])[0] ?? {};
      const prepared = (preparedRows as unknown as Record<string, unknown>[])[0] ?? {};

      return {
        customers: {
          total: readNumber(customer, "total"),
          active: readNumber(customer, "active"),
          blocked: readNumber(customer, "blocked"),
          archived: readNumber(customer, "archived"),
        },
        problems: {
          open: readNumber(problem, "open"),
          waiting: readNumber(problem, "waiting"),
          inProgress: readNumber(problem, "in_progress"),
          blocking: readNumber(problem, "blocking"),
          accountsAffected: readNumber(problem, "accounts_affected"),
          paymentProblems: readNumber(problem, "payment_problems"),
          paymentProblemAccounts: readNumber(problem, "payment_problem_accounts"),
          resolvedToday: readNumber(problem, "resolved_today"),
          critical: readNumber(problem, "critical"),
        },
        users: {
          active: readNumber(user, "active"),
          suspended: readNumber(user, "suspended"),
          disabled: readNumber(user, "disabled"),
        },
        prepared: {
          today: readNumber(prepared, "today"),
          yesterday: readNumber(prepared, "yesterday"),
          thisWeek: readNumber(prepared, "this_week"),
          thisMonth: readNumber(prepared, "this_month"),
        },
      };
    });
  },

  async accountStateInputs() {
    return databaseAdapter.query("dashboard.accountStateInputs", (executor) =>
      /*
       * Four columns per live account — no credential, no notes. Blocking
       * problems are added by the service through problemsService, exactly as
       * the Accounts list adds them, so both screens feed the same inputs to
       * `accountEffectiveStatus`.
       */
      executor
        .select({
          id: accounts.id,
          status: accounts.status,
          validUntil: accounts.validUntil,
          deletedAt: accounts.deletedAt,
        })
        .from(accounts)
        .where(accountIsLiveSql),
    );
  },

  async profileStateInputs() {
    return databaseAdapter.query("dashboard.profileStateInputs", async (executor) => {
      /*
       * One query for every profile, account facts joined. The has-blocking-
       * problem flag is the negation of the same predicate `accountCanAllocate`
       * leans on in SQL, so the input matches what the Accounts list receives
       * from problemsService.
       */
      const rows = await executor
        .select({
          profile: profiles,
          profileSlots: accounts.profileSlots,
          validUntil: accounts.validUntil,
          status: accounts.status,
          deletedAt: accounts.deletedAt,
          /*
           * mapWith: a raw sql fragment carries no column type, so without it
           * Drizzle applies no mapper and the driver's value comes back as
           * decoded — the defect that once broke the Users page. Coerced here
           * so the declared boolean is true.
           */
          hasBlockingProblem: sql<boolean>`not ${accountHasNoBlockingProblemSql}`.mapWith(
            (value) => value === true || value === "t" || value === "true",
          ),
        })
        .from(profiles)
        .innerJoin(accounts, eq(accounts.id, profiles.accountId))
        .where(accountIsLiveSql);

      return rows.map((row) => ({
        profile: row.profile,
        account: {
          profileSlots: row.profileSlots,
          validUntil: row.validUntil,
          status: row.status,
          deletedAt: row.deletedAt,
        },
        hasBlockingProblem: row.hasBlockingProblem,
      }));
    });
  },

  async backupSummary() {
    return databaseAdapter.query("dashboard.backupSummary", async (executor) => {
      const rows = await executor.execute(sql`
        select
          (select max(created_at) from backups where status in ('completed', 'verified')) as last_backup_at,
          (select max(created_at) from backups where type = 'snapshot' and status in ('completed', 'verified')) as last_snapshot_at,
          (select count(*)::int from backups where status = 'failed') as failed,
          (
            select status = 'verified'
            from backups
            where status in ('completed', 'verified')
            order by created_at desc limit 1
          ) as last_verified,
          (
            select size_bytes from backups
            where status in ('completed', 'verified')
            order by created_at desc limit 1
          ) as last_size,
          (
            select extract(epoch from (completed_at - created_at)) * 1000
            from backups
            where status in ('completed', 'verified') and completed_at is not null
            order by created_at desc limit 1
          ) as last_duration_ms
      `);

      const row = (rows as unknown as Record<string, unknown>[])[0] ?? {};

      return {
        lastBackupAt: readDate(row, "last_backup_at"),
        lastSnapshotAt: readDate(row, "last_snapshot_at"),
        failed: readNumber(row, "failed"),
        lastChecksumVerified: row["last_verified"] === true,
        lastSizeBytes: row["last_size"] === null ? null : readNumber(row, "last_size"),
        lastDurationMs:
          row["last_duration_ms"] === null ? null : Math.round(readNumber(row, "last_duration_ms")),
      };
    });
  },

  async recentActivity(limit, offset) {
    return databaseAdapter.query("dashboard.recentActivity", async (executor) => {
      /*
       * A SQL UNION, not three queries stitched together in JavaScript.
       * Ordering has to happen across all three sources before the limit, or
       * the feed would show the newest N of each rather than the newest N
       * overall — the same reasoning as the M06 activity feed.
       */
      const rows = await executor.execute(sql`
        (
          select
            a.id::text as id,
            'audit' as source,
            a.action::text as action,
            a.entity::text as entity,
            u.name as actor_name,
            a.created_at as created_at
          from audit_logs a
          left join users u on u.id = a.user_id
        )
        union all
        (
          select
            e.id::text as id,
            'profile' as source,
            e.event_type::text as action,
            'profile' as entity,
            u.name as actor_name,
            e.created_at as created_at
          from profile_events e
          left join users u on u.id = e.user_id
        )
        union all
        (
          select
            l.id::text as id,
            'auth' as source,
            l.event_type::text as action,
            null as entity,
            coalesce(u.name, l.email) as actor_name,
            l.created_at as created_at
          from login_history l
          left join users u on u.id = l.user_id
        )
        order by created_at desc
        limit ${limit} offset ${offset}
      `);

      return (rows as unknown as Record<string, unknown>[]).map((row): ActivityRow => ({
        id: String(row["id"]),
        source:
          row["source"] === "audit" ? "audit" : row["source"] === "profile" ? "profile" : "auth",
        action: String(row["action"]),
        entity: row["entity"] === null ? null : String(row["entity"]),
        actorName: row["actor_name"] === null ? null : String(row["actor_name"]),
        createdAt: new Date(String(row["created_at"])),
      }));
    });
  },

  async recentProfileActivity(limit, offset) {
    return databaseAdapter.query("dashboard.recentProfileActivity", async (executor) => {
      const rows = await executor.execute(sql`
        select
          e.id::text as id,
          'profile' as source,
          e.event_type::text as action,
          'profile' as entity,
          u.name as actor_name,
          e.created_at as created_at
        from profile_events e
        left join users u on u.id = e.user_id
        order by e.created_at desc
        limit ${limit} offset ${offset}
      `);

      return (rows as unknown as Record<string, unknown>[]).map((row): ActivityRow => ({
        id: String(row["id"]),
        source: "profile",
        action: String(row["action"]),
        entity: "profile",
        actorName: row["actor_name"] === null ? null : String(row["actor_name"]),
        createdAt: new Date(String(row["created_at"])),
      }));
    });
  },

  async reopenedProblems(limit) {
    return databaseAdapter.query("dashboard.reopenedProblems", async (executor) => {
      const rows = await executor.execute(sql`
        select * from issues
        where reopen_count > 0
        order by reopen_count desc, updated_at desc
        limit ${limit}
      `);

      return rows as unknown as IssueRow[];
    });
  },

  async stockCandidates(limit) {
    return databaseAdapter.query("dashboard.stockCandidates", async (executor) => {
      /*
       * Through the query builder, so rows arrive in the schema's camelCase.
       *
       * This used to be `to_jsonb(a)` / `to_jsonb(p)` cast to AccountRow and
       * ProfileRow — but to_jsonb keeps the database's snake_case keys, so
       * `profileSlots`, `profileNumber` and `validUntil` were all undefined.
       * `evaluateAllocation` then judged every profile "not for sale" and the
       * widget reported no stock at all, whatever the shelf held. The existing
       * tests only asserted over non-empty results and so passed on nothing.
       *
       * The credential is not selected: nothing here needs it.
       */
      /* Every column except the credential, which is never read. */
      const { passwordEncrypted: _credential, ...accountColumns } = getTableColumns(accounts);

      const accountRows = await executor
        .select({ account: accountColumns })
        .from(accounts)
        .where(and(accountIsLiveSql, ne(accounts.status, "archived")))
        .orderBy(asc(accounts.createdAt))
        .limit(limit);

      if (accountRows.length === 0) {
        return [];
      }

      const ids = accountRows.map((row) => row.account.id);

      const profileRows = await executor
        .select()
        .from(profiles)
        .where(inArray(profiles.accountId, ids))
        .orderBy(asc(profiles.profileNumber));

      const blocked = await executor
        .selectDistinct({ accountId: issues.accountId })
        .from(issues)
        .where(
          and(
            inArray(issues.accountId, ids),
            inArray(issues.status, ["open", "in_progress", "waiting"]),
          ),
        );

      const blockedIds = new Set(blocked.map((row) => row.accountId));

      return accountRows.map(({ account }) => ({
        /*
         * evaluateAllocation takes an AccountRow; it never reads the password.
         * An empty placeholder satisfies the type without the value existing.
         */
        account: { ...account, passwordEncrypted: "" },
        profiles: profileRows.filter((profile) => profile.accountId === account.id),
        hasActiveProblem: blockedIds.has(account.id),
      }));
    });
  },

  async accountsCreatedByDay(days) {
    return seriesByDay("accounts", days);
  },

  async customersCreatedByDay(days) {
    return seriesByDay("customers", days);
  },

  async backupsByDay(days) {
    return seriesByDay("backups", days);
  },

  async problemsBySeverity() {
    return databaseAdapter.query("dashboard.problemsBySeverity", async (executor) => {
      const rows = await executor.execute(sql`
        select i.severity::text as label, count(*)::int as count
        from issues i
        join accounts a on a.id = i.account_id
        where i.status in ('open', 'in_progress', 'waiting') and ${rawAccountIsLive("a")}
        group by i.severity
      `);

      return (rows as unknown as Record<string, unknown>[]).map((row) => ({
        label: String(row["label"]),
        count: readNumber(row, "count"),
      }));
    });
  },

  async problemsByType() {
    return databaseAdapter.query("dashboard.problemsByType", async (executor) => {
      const rows = await executor.execute(sql`
        select i.issue_type::text as label, count(*)::int as count
        from issues i
        join accounts a on a.id = i.account_id
        where i.status in ('open', 'in_progress', 'waiting') and ${rawAccountIsLive("a")}
        group by i.issue_type
        order by count(*) desc, i.issue_type
      `);

      return (rows as unknown as Record<string, unknown>[]).map((row) => ({
        label: String(row["label"]),
        count: readNumber(row, "count"),
      }));
    });
  },
};

/**
 * Rows created per day, zero-filled.
 *
 * `generate_series` supplies every day in the window so a gap renders as zero
 * rather than as a missing point — a line chart that skipped empty days would
 * imply activity that did not happen.
 *
 * The table name is not user input: it comes from the three call sites above,
 * each a literal.
 */
async function seriesByDay(
  table: "accounts" | "customers" | "backups",
  days: number,
): Promise<Result<readonly SeriesPoint[]>> {
  return databaseAdapter.query(`dashboard.seriesByDay.${table}`, async (executor) => {
    const rows = await executor.execute(sql`
      select
        to_char(d.day at time zone 'UTC', 'YYYY-MM-DD') as day,
        coalesce(count(t.id), 0)::int as count
      from generate_series(
        date_trunc('day', now(), 'UTC') - make_interval(days => ${days - 1}),
        date_trunc('day', now(), 'UTC'),
        interval '1 day'
      ) as d(day)
      left join ${sql.identifier(table)} t
        on date_trunc('day', t.created_at, 'UTC') = d.day
      group by d.day
      order by d.day asc
    `);

    return (rows as unknown as Record<string, unknown>[]).map((row) => ({
      day: String(row["day"]),
      count: readNumber(row, "count"),
    }));
  });
}
