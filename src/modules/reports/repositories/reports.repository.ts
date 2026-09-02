import { sql, type SQL } from "drizzle-orm";

import { databaseAdapter } from "@/lib/database";
import { rawSellableSlot } from "@/lib/drizzle/predicates";
import type { Result } from "@/types/result";
import type { ReportKey } from "../services/report-definitions";
import type { ReportFilters } from "../validation/report.schema";

/**
 * Reports repository.
 *
 * Two reads per report: a summary (aggregates, one row) and a dataset (the rows
 * an export contains, paged).
 *
 * Every aggregate is computed in SQL. Pulling rows into JavaScript to count
 * them would be the N+1 the brief forbids, and an average resolution time
 * calculated over a paged subset would simply be wrong.
 *
 * The dataset reads are paged because the export streams — see ADR-011
 * Decision 3. `datasetPage` is called repeatedly by the export route and never
 * materialises the whole result.
 */

export type ReportRow = Record<string, unknown>;
export type ReportSummary = Record<string, number | string | null>;

function readRows(result: unknown): ReportRow[] {
  return result as unknown as ReportRow[];
}

/** Date bounds, applied to whichever column the report considers its timeline. */
function dateBounds(filters: ReportFilters, column: SQL): SQL {
  const clauses: SQL[] = [];

  if (filters.from) {
    clauses.push(sql`${column} >= ${filters.from}::timestamptz`);
  }

  if (filters.to) {
    /* Inclusive of the whole end day: a report "to the 5th" must include the 5th. */
    clauses.push(sql`${column} < (${filters.to}::timestamptz + interval '1 day')`);
  }

  return clauses.length === 0 ? sql`true` : sql.join(clauses, sql` and `);
}

function like(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? `%${trimmed}%` : null;
}

export interface ReportsRepository {
  summary(report: ReportKey, filters: ReportFilters): Promise<Result<ReportSummary>>;
  datasetPage(
    report: ReportKey,
    filters: ReportFilters,
    limit: number,
    offset: number,
  ): Promise<Result<readonly ReportRow[]>>;
  datasetCount(report: ReportKey, filters: ReportFilters): Promise<Result<number>>;
}

/* ------------------------------------------------------------------ */
/* Dataset queries. One per report, each filterable and pageable.      */
/* ------------------------------------------------------------------ */

function datasetQuery(report: ReportKey, filters: ReportFilters): SQL {
  const search = like(filters.search);

  switch (report) {
    case "accounts":
      return sql`
        select
          a.email as "email",
          a.status::text as "status",
          count(p.id)::int as "totalProfiles",
          /* Sellable slots only. M13: rows above a.profile_slots are not stock. */
          count(p.id) filter (
            where p.status = 'available' and ${rawSellableSlot("p", "a")}
          )::int as "availableProfiles",
          count(p.id) filter (where p.status = 'sold')::int as "soldProfiles",
          count(p.id) filter (where not ${rawSellableSlot("p", "a")})::int as "notForSaleProfiles",
          (
            select count(*)::int from issues i
            where i.account_id = a.id and i.status in ('open', 'in_progress', 'waiting')
          ) as "openProblems",
          to_char(a.created_at, 'YYYY-MM-DD') as "createdAt"
        from accounts a
        left join profiles p on p.account_id = a.id
        where ${dateBounds(filters, sql`a.created_at`)}
          and (${filters.status ?? null}::text is null or a.status::text = ${filters.status ?? null})
          and (${filters.accountId ?? null}::uuid is null or a.id = ${filters.accountId ?? null}::uuid)
          and (${search}::text is null or a.email ilike ${search})
        group by a.id
        order by a.created_at desc
      `;

    case "profiles":
      return sql`
        select
          a.email as "accountEmail",
          p.profile_number as "profileNumber",
          p.status::text as "status",
          c.name as "customerName",
          to_char(p.expiration_date, 'YYYY-MM-DD') as "expirationDate",
          (
            select count(*)::int from profile_events e
            where e.profile_id = p.id and e.event_type = 'replaced'
          ) as "replacements"
        from profiles p
        join accounts a on a.id = p.account_id
        left join customers c on c.id = p.customer_id
        where ${dateBounds(filters, sql`p.created_at`)}
          and (${filters.status ?? null}::text is null or p.status::text = ${filters.status ?? null})
          and (${filters.accountId ?? null}::uuid is null or p.account_id = ${filters.accountId ?? null}::uuid)
          and (${filters.customerId ?? null}::uuid is null or p.customer_id = ${filters.customerId ?? null}::uuid)
          and (${search}::text is null or a.email ilike ${search} or c.name ilike ${search})
        order by a.email asc, p.profile_number asc
      `;

    case "customers":
      return sql`
        select
          c.name as "name",
          c.phone_normalized as "phoneNormalized",
          count(p.id)::int as "subscriptions",
          count(p.id) filter (
            where p.status in ('sold', 'expiring_soon')
              and (p.expiration_date is null or p.expiration_date >= current_date)
          )::int as "liveSubscriptions",
          (
            select count(*)::int from profile_events e
            where e.customer_id = c.id and e.event_type = 'replaced'
          ) as "replacements",
          case
            when c.deleted_at is not null then 'archived'
            when c.blocked_at is not null then 'blocked'
            when count(p.id) filter (
              where p.status in ('sold', 'expiring_soon')
                and (p.expiration_date is null or p.expiration_date >= current_date)
            ) > 0 then 'active'
            else 'inactive'
          end as "status",
          to_char(c.created_at, 'YYYY-MM-DD') as "createdAt"
        from customers c
        left join profiles p on p.customer_id = c.id
        where ${dateBounds(filters, sql`c.created_at`)}
          and (${filters.customerId ?? null}::uuid is null or c.id = ${filters.customerId ?? null}::uuid)
          and (${search}::text is null or c.name ilike ${search} or c.phone_normalized ilike ${search})
        group by c.id
        order by c.created_at desc
      `;

    case "problems":
      return sql`
        select
          a.email as "accountEmail",
          i.issue_type::text as "issueType",
          i.severity::text as "severity",
          i.status::text as "status",
          u.name as "assignedToName",
          i.reopen_count as "reopenCount",
          case
            when i.resolved_at is null then null
            else round(extract(epoch from (i.resolved_at - i.created_at)) / 3600.0, 1)
          end as "resolutionHours",
          to_char(i.created_at, 'YYYY-MM-DD') as "createdAt"
        from issues i
        join accounts a on a.id = i.account_id
        left join users u on u.id = i.assigned_to
        where ${dateBounds(filters, sql`i.created_at`)}
          and (${filters.status ?? null}::text is null or i.status::text = ${filters.status ?? null})
          and (${filters.severity ?? null}::text is null or i.severity::text = ${filters.severity ?? null})
          and (${filters.problemType ?? null}::text is null or i.issue_type::text = ${filters.problemType ?? null})
          and (${filters.workerId ?? null}::uuid is null or i.assigned_to = ${filters.workerId ?? null}::uuid)
          and (${filters.accountId ?? null}::uuid is null or i.account_id = ${filters.accountId ?? null}::uuid)
          and (${search}::text is null or a.email ilike ${search} or i.description ilike ${search})
        order by i.created_at desc
      `;

    case "users":
      return sql`
        select
          u.name as "name",
          u.email as "email",
          u.role::text as "role",
          u.status::text as "status",
          to_char(u.last_login_at, 'YYYY-MM-DD HH24:MI') as "lastLoginAt",
          (select count(*)::int from issues i where i.assigned_to = u.id) as "problemsAssigned"
        from users u
        where ${dateBounds(filters, sql`u.created_at`)}
          and (${filters.status ?? null}::text is null or u.status::text = ${filters.status ?? null})
          and (${filters.workerId ?? null}::uuid is null or u.id = ${filters.workerId ?? null}::uuid)
          and (${search}::text is null or u.name ilike ${search} or u.email ilike ${search})
        order by u.created_at asc
      `;

    case "backups":
      return sql`
        select
          b.name as "name",
          b.type::text as "type",
          b.status::text as "status",
          b.size_bytes as "sizeBytes",
          case when b.status = 'verified' then 'Verified' else 'Unverified' end as "checksumVerified",
          to_char(b.created_at, 'YYYY-MM-DD HH24:MI') as "createdAt"
        from backups b
        where ${dateBounds(filters, sql`b.created_at`)}
          and (${filters.status ?? null}::text is null or b.status::text = ${filters.status ?? null})
          and (${filters.backupType ?? null}::text is null or b.type::text = ${filters.backupType ?? null})
        order by b.created_at desc
      `;

    case "quick-prepare":
      return sql`
        select
          to_char(d.day, 'YYYY-MM-DD') as "day",
          count(e.id) filter (where e.event_type = 'sold')::int as "allocations",
          count(e.id) filter (where e.event_type = 'replaced')::int as "replacements",
          count(e.id) filter (where e.event_type = 'extended')::int as "extensions"
        from generate_series(
          coalesce(${filters.from ?? null}::timestamptz, date_trunc('day', now()) - interval '29 days'),
          coalesce(${filters.to ?? null}::timestamptz, date_trunc('day', now())),
          interval '1 day'
        ) as d(day)
        left join profile_events e
          on date_trunc('day', e.created_at) = date_trunc('day', d.day)
         and (${filters.workerId ?? null}::uuid is null or e.user_id = ${filters.workerId ?? null}::uuid)
         and (${filters.accountId ?? null}::uuid is null or e.account_id = ${filters.accountId ?? null}::uuid)
        group by d.day
        order by d.day desc
      `;

    case "audit-summary":
      return sql`
        select
          to_char(date_trunc('day', al.created_at), 'YYYY-MM-DD') as "day",
          al.entity::text as "entity",
          al.action::text as "action",
          coalesce(u.name, 'System') as "actorName",
          count(*)::int as "count"
        from audit_logs al
        left join users u on u.id = al.user_id
        where ${dateBounds(filters, sql`al.created_at`)}
          and (${filters.workerId ?? null}::uuid is null or al.user_id = ${filters.workerId ?? null}::uuid)
        group by 1, 2, 3, 4
        order by 1 desc, 5 desc
      `;

    case "activity-summary":
      return sql`
        select
          to_char(d.day, 'YYYY-MM-DD') as "day",
          (
            select count(*)::int from login_history l
            where date_trunc('day', l.created_at) = d.day and l.event_type = 'login_success'
          ) as "logins",
          (
            select count(*)::int from login_history l
            where date_trunc('day', l.created_at) = d.day and l.event_type = 'login_failed'
          ) as "failedLogins",
          (
            select count(*)::int from audit_logs al
            where date_trunc('day', al.created_at) = d.day and al.entity = 'issue'
          ) as "problemEvents",
          (
            select count(*)::int from profile_events e
            where date_trunc('day', e.created_at) = d.day and e.event_type = 'sold'
          ) as "allocationEvents"
        from generate_series(
          coalesce(${filters.from ?? null}::timestamptz, date_trunc('day', now()) - interval '29 days'),
          coalesce(${filters.to ?? null}::timestamptz, date_trunc('day', now())),
          interval '1 day'
        ) as d(day)
        order by d.day desc
      `;

    case "system-health":
      /*
       * The only report with no table behind it. Its rows are the health
       * findings, which the service composes from `assessHealth` — reusing the
       * M09 rule rather than restating it here in SQL.
       */
      return sql`select null::text as "check" where false`;
  }
}

/* ------------------------------------------------------------------ */
/* Summary queries. One aggregate row per report.                      */
/* ------------------------------------------------------------------ */

function summaryQuery(report: ReportKey, filters: ReportFilters): SQL | null {
  switch (report) {
    case "accounts":
      return sql`
        select
          count(*)::int as "total",
          count(*) filter (where status = 'healthy' and deleted_at is null)::int as "healthy",
          count(*) filter (where status = 'archived')::int as "archived",
          count(*) filter (where status = 'deleted' or deleted_at is not null)::int as "deleted",
          (
            select count(distinct account_id)::int from issues
            where status in ('open', 'in_progress', 'waiting')
          ) as "problemAccounts",
          /*
           * Stock is SELLABLE capacity, not raw row count. M13: an account with
           * profile_slots = 2 has five rows and two of them are stock, so
           * counting rows would overstate the catalogue by the slots nobody can
           * ever sell.
           */
          (
            select count(*)::int from profiles p
            join accounts a2 on a2.id = p.account_id
            where ${rawSellableSlot("p", "a2")}
          ) as "stockTotal",
          (
            select count(*)::int from profiles p
            join accounts a2 on a2.id = p.account_id
            where p.status = 'available' and ${rawSellableSlot("p", "a2")}
          ) as "stockAvailable",
          /*
           * Measured against sellable capacity for the same reason, and to match
           * the utilization figure in the profiles report. Dividing by all five
           * rows would cap a two-slot account at 40% however completely it sold
           * out, which reads as poor performance rather than as a full account.
           */
          coalesce(round(
            100.0 * (
              select count(*) from profiles p
              join accounts a2 on a2.id = p.account_id
              where p.status = 'sold' and ${rawSellableSlot("p", "a2")}
            )
              / nullif((
                select count(*) from profiles p
                join accounts a2 on a2.id = p.account_id
                where ${rawSellableSlot("p", "a2")}
              ), 0), 1
          ), 0)::float8 as "allocationRate"
        from accounts
        where ${dateBounds(filters, sql`created_at`)}
      `;

    case "profiles":
      return sql`
        select
          count(*) filter (
            where p.status = 'available' and ${rawSellableSlot("p", "a")}
          )::int as "available",
          count(*) filter (where p.status = 'reserved')::int as "reserved",
          count(*) filter (where p.status = 'sold')::int as "sold",
          count(*) filter (where not ${rawSellableSlot("p", "a")})::int as "notForSale",
          count(*) filter (where p.expiration_date >= current_date and p.expiration_date <= current_date + 7)::int as "expiring",
          count(*) filter (where p.expiration_date < current_date)::int as "expired",
          (select count(*)::int from profile_events where event_type = 'replaced') as "replacementCount",
          /*
           * Utilization is measured against SELLABLE capacity, not against every
           * row. Counting slots the account does not sell would permanently cap
           * a three-profile account at 60% and make the number meaningless.
           */
          coalesce(round(
            100.0 * count(*) filter (where p.status in ('sold', 'reserved'))
              / nullif(count(*) filter (where ${rawSellableSlot("p", "a")}), 0), 1
          ), 0)::float8 as "utilization"
        from profiles p
        join accounts a on a.id = p.account_id
      `;

    case "customers":
      return sql`
        select
          count(*) filter (where ${dateBounds(filters, sql`c.created_at`)})::int as "newCustomers",
          count(*) filter (
            where c.deleted_at is null and c.blocked_at is null and exists (
              select 1 from profiles p where p.customer_id = c.id
                and p.status in ('sold', 'expiring_soon')
                and (p.expiration_date is null or p.expiration_date >= current_date)
            )
          )::int as "active",
          count(*) filter (where c.blocked_at is not null and c.deleted_at is null)::int as "blocked",
          count(*) filter (where c.deleted_at is not null)::int as "archived",
          (select count(*)::int from profile_events where event_type = 'replaced') as "replacementFrequency",
          coalesce(round(
            (select count(*)::numeric from profiles where customer_id is not null)
              / nullif(count(*) filter (where c.deleted_at is null), 0), 2
          ), 0)::float8 as "subscriptionsPerCustomer"
        from customers c
      `;

    case "problems":
      return sql`
        select
          count(*) filter (where status = 'open')::int as "open",
          count(*) filter (where status = 'waiting')::int as "waiting",
          count(*) filter (where status in ('resolved', 'closed'))::int as "resolved",
          count(*) filter (where severity = 'critical' and status in ('open', 'in_progress', 'waiting'))::int as "critical",
          coalesce(round(
            avg(extract(epoch from (resolved_at - created_at)) / 3600.0) filter (where resolved_at is not null), 1
          ), 0)::float8 as "averageResolutionHours",
          count(*) filter (where reopen_count > 0)::int as "reopened",
          count(*) filter (where assigned_to is not null)::int as "assigned"
        from issues
        where ${dateBounds(filters, sql`created_at`)}
      `;

    case "users":
      return sql`
        select
          count(*) filter (where status = 'active' and deleted_at is null)::int as "active",
          count(*) filter (where status = 'suspended')::int as "suspended",
          count(*) filter (where status = 'disabled')::int as "disabled",
          count(*) filter (where last_login_at is not null)::int as "haveSignedIn",
          to_char(max(last_login_at), 'YYYY-MM-DD HH24:MI') as "lastLogin"
        from users
      `;

    case "backups":
      return sql`
        select
          count(*)::int as "total",
          count(*) filter (where type = 'snapshot')::int as "snapshots",
          count(*) filter (where status = 'failed')::int as "failed",
          count(*) filter (where status = 'verified')::int as "verified",
          coalesce(sum(size_bytes) filter (where status in ('completed', 'verified')), 0)::float8 as "storageBytes",
          to_char(max(created_at) filter (where status in ('completed', 'verified')), 'YYYY-MM-DD HH24:MI') as "lastBackup"
        from backups
        where ${dateBounds(filters, sql`created_at`)}
      `;

    case "quick-prepare":
      return sql`
        select
          count(*) filter (where event_type = 'sold' and created_at >= date_trunc('day', now()))::int as "today",
          count(*) filter (where event_type = 'sold' and created_at >= date_trunc('week', now()))::int as "weekly",
          count(*) filter (where event_type = 'sold' and created_at >= date_trunc('month', now()))::int as "monthly",
          count(*) filter (where event_type = 'replaced')::int as "replacements"
        from profile_events
        where ${dateBounds(filters, sql`created_at`)}
      `;

    case "audit-summary":
      return sql`
        select
          count(*)::int as "entries",
          count(distinct entity)::int as "entities",
          count(distinct user_id)::int as "actors",
          to_char(min(created_at), 'YYYY-MM-DD') as "firstEntry",
          to_char(max(created_at), 'YYYY-MM-DD') as "lastEntry"
        from audit_logs
        where ${dateBounds(filters, sql`created_at`)}
      `;

    case "activity-summary":
      return sql`
        select
          (select count(*)::int from login_history where event_type = 'login_success'
            and ${dateBounds(filters, sql`created_at`)}) as "logins",
          (select count(*)::int from login_history where event_type = 'login_failed'
            and ${dateBounds(filters, sql`created_at`)}) as "failedLogins",
          (select count(*)::int from audit_logs where entity = 'issue'
            and ${dateBounds(filters, sql`created_at`)}) as "problemActivity",
          (select count(*)::int from profile_events where event_type = 'sold'
            and ${dateBounds(filters, sql`created_at`)}) as "allocationActivity"
      `;

    case "system-health":
      /* Composed by the service from assessHealth, not from SQL. */
      return null;
  }
}

export const reportsRepository: ReportsRepository = {
  async summary(report, filters) {
    const query = summaryQuery(report, filters);

    if (!query) {
      return databaseAdapter.query("reports.summary.none", async () => ({}) as ReportSummary);
    }

    return databaseAdapter.query(`reports.summary.${report}`, async (executor) => {
      const rows = readRows(await executor.execute(query));
      return (rows[0] ?? {}) as ReportSummary;
    });
  },

  async datasetPage(report, filters, limit, offset) {
    if (report === "system-health") {
      return databaseAdapter.query("reports.dataset.none", async () => []);
    }

    return databaseAdapter.query(`reports.dataset.${report}`, async (executor) => {
      /*
       * The page is applied around the report's own query rather than inside
       * each one, so every report pages identically and a new report cannot
       * forget to.
       */
      const rows = await executor.execute(sql`
        select * from (${datasetQuery(report, filters)}) as report
        limit ${limit} offset ${offset}
      `);

      return readRows(rows);
    });
  },

  async datasetCount(report, filters) {
    if (report === "system-health") {
      return databaseAdapter.query("reports.count.none", async () => 0);
    }

    return databaseAdapter.query(`reports.count.${report}`, async (executor) => {
      const rows = readRows(
        await executor.execute(sql`
          select count(*)::int as count from (${datasetQuery(report, filters)}) as report
        `),
      );

      const value = rows[0]?.["count"];
      return typeof value === "number" ? value : Number(value ?? 0);
    });
  },
};
