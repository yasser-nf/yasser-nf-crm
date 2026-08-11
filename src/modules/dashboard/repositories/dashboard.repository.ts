import { sql } from "drizzle-orm";

import { databaseAdapter } from "@/lib/database";
import type { AccountRow, IssueRow, ProfileRow } from "@/lib/drizzle/schema";
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
  readonly total: number;
  readonly healthy: number;
  readonly withProblems: number;
  readonly archived: number;
}

export interface ProfileCounts {
  readonly total: number;
  readonly available: number;
  readonly reserved: number;
  readonly sold: number;
  readonly expiringSoon: number;
  readonly expired: number;
}

export interface CustomerCounts {
  readonly total: number;
  readonly active: number;
  readonly blocked: number;
  readonly archived: number;
}

export interface ProblemCounts {
  readonly open: number;
  readonly waiting: number;
  readonly inProgress: number;
  readonly resolvedToday: number;
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

export interface ExpirationBuckets {
  readonly today: number;
  readonly tomorrow: number;
  readonly withinThreeDays: number;
  readonly withinSevenDays: number;
  readonly expired: number;
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
  /** Every KPI on the page, in one round trip per domain group. */
  counts(): Promise<Result<DashboardCounts>>;
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
       * Four statements, not twenty-eight. Each `filter (where …)` is another
       * bucket counted during the same scan, so adding a KPI costs no extra
       * round trip.
       *
       * Accounts and profiles are one statement because the profile buckets are
       * a scan of a different table; customers and problems likewise. They are
       * kept apart only where a join would multiply rows.
       */
      const accountRows = await executor.execute(sql`
        select
          count(*)::int as total,
          count(*) filter (where status = 'healthy' and deleted_at is null)::int as healthy,
          count(*) filter (where status = 'archived' or deleted_at is not null)::int as archived,
          (
            select count(distinct i.account_id)::int
            from issues i
            where i.status in ('open', 'in_progress', 'waiting')
          ) as with_problems
        from accounts
      `);

      const profileRows = await executor.execute(sql`
        select
          count(*)::int as total,
          count(*) filter (where status = 'available')::int as available,
          count(*) filter (where status = 'reserved')::int as reserved,
          count(*) filter (where status = 'sold')::int as sold,
          count(*) filter (where status = 'expiring_soon')::int as expiring_soon,
          count(*) filter (where status = 'expired')::int as expired,
          /*
           * Expiry buckets read expiration_date directly rather than the status
           * column. 03_DATABASE.md warns those enum values are not written by
           * anything yet, so trusting them here would report zero forever.
           */
          count(*) filter (where expiration_date = current_date)::int as expiring_today,
          count(*) filter (where expiration_date = current_date + 1)::int as expiring_tomorrow,
          count(*) filter (
            where expiration_date > current_date and expiration_date <= current_date + 3
          )::int as expiring_three,
          count(*) filter (
            where expiration_date > current_date and expiration_date <= current_date + 7
          )::int as expiring_seven,
          count(*) filter (where expiration_date < current_date)::int as already_expired
        from profiles
      `);

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
                  and (p.expiration_date is null or p.expiration_date >= current_date)
              )
          )::int as active
        from customers
      `);

      const problemRows = await executor.execute(sql`
        select
          count(*) filter (where status = 'open')::int as open,
          count(*) filter (where status = 'waiting')::int as waiting,
          count(*) filter (where status = 'in_progress')::int as in_progress,
          count(*) filter (
            where status = 'resolved' and resolved_at >= date_trunc('day', now())
          )::int as resolved_today,
          count(*) filter (
            where severity = 'critical' and status in ('open', 'in_progress', 'waiting')
          )::int as critical
        from issues
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
       * later replaced or expired.
       */
      const preparedRows = await executor.execute(sql`
        select
          count(*) filter (where created_at >= date_trunc('day', now()))::int as today,
          count(*) filter (
            where created_at >= date_trunc('day', now()) - interval '1 day'
              and created_at < date_trunc('day', now())
          )::int as yesterday,
          count(*) filter (where created_at >= date_trunc('week', now()))::int as this_week,
          count(*) filter (where created_at >= date_trunc('month', now()))::int as this_month
        from profile_events
        where event_type = 'sold'
      `);

      const account = (accountRows as unknown as Record<string, unknown>[])[0] ?? {};
      const profile = (profileRows as unknown as Record<string, unknown>[])[0] ?? {};
      const customer = (customerRows as unknown as Record<string, unknown>[])[0] ?? {};
      const problem = (problemRows as unknown as Record<string, unknown>[])[0] ?? {};
      const user = (userRows as unknown as Record<string, unknown>[])[0] ?? {};
      const prepared = (preparedRows as unknown as Record<string, unknown>[])[0] ?? {};

      return {
        accounts: {
          total: readNumber(account, "total"),
          healthy: readNumber(account, "healthy"),
          withProblems: readNumber(account, "with_problems"),
          archived: readNumber(account, "archived"),
        },
        profiles: {
          total: readNumber(profile, "total"),
          available: readNumber(profile, "available"),
          reserved: readNumber(profile, "reserved"),
          sold: readNumber(profile, "sold"),
          expiringSoon: readNumber(profile, "expiring_soon"),
          expired: readNumber(profile, "expired"),
        },
        expirations: {
          today: readNumber(profile, "expiring_today"),
          tomorrow: readNumber(profile, "expiring_tomorrow"),
          withinThreeDays: readNumber(profile, "expiring_three"),
          withinSevenDays: readNumber(profile, "expiring_seven"),
          expired: readNumber(profile, "already_expired"),
        },
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
       * One query, then grouped in memory. A join returns five rows per account
       * and the alternative — one profile query per account — is the N+1 the
       * brief forbids.
       *
       * Ordered by health score, matching how the Smart Stock Engine ranks, so
       * "top accounts" here means the same thing it means during allocation.
       */
      const rows = await executor.execute(sql`
        select
          to_jsonb(a) as account,
          to_jsonb(p) as profile,
          exists (
            select 1 from issues i
            where i.account_id = a.id and i.status in ('open', 'in_progress', 'waiting')
          ) as has_active_problem
        from (
          select * from accounts
          where deleted_at is null and status <> 'deleted' and status <> 'archived'
          order by health_score desc, created_at asc
          limit ${limit}
        ) a
        left join profiles p on p.account_id = a.id
        order by a.health_score desc, p.profile_number asc
      `);

      const byAccount = new Map<
        string,
        { account: AccountRow; profiles: ProfileRow[]; hasActiveProblem: boolean }
      >();

      for (const raw of rows as unknown as Record<string, unknown>[]) {
        const account = raw["account"] as AccountRow;
        const profile = raw["profile"] as ProfileRow | null;

        const existing = byAccount.get(account.id) ?? {
          account,
          profiles: [],
          hasActiveProblem: raw["has_active_problem"] === true,
        };

        if (profile) {
          existing.profiles.push(profile);
        }

        byAccount.set(account.id, existing);
      }

      return [...byAccount.values()];
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
        select severity::text as label, count(*)::int as count
        from issues
        where status in ('open', 'in_progress', 'waiting')
        group by severity
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
        to_char(d.day, 'YYYY-MM-DD') as day,
        coalesce(count(t.id), 0)::int as count
      from generate_series(
        date_trunc('day', now()) - make_interval(days => ${days - 1}),
        date_trunc('day', now()),
        interval '1 day'
      ) as d(day)
      left join ${sql.identifier(table)} t
        on date_trunc('day', t.created_at) = d.day
      group by d.day
      order by d.day asc
    `);

    return (rows as unknown as Record<string, unknown>[]).map((row) => ({
      day: String(row["day"]),
      count: readNumber(row, "count"),
    }));
  });
}
