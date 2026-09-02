import {
  Activity,
  CalendarClock,
  ChartColumn,
  CircleCheck,
  DatabaseBackup,
  HeartPulse,
  Layers,
  ShoppingCart,
  TriangleAlert,
  Users as UsersIcon,
  Wallet,
  Zap,
} from "lucide-react";
import Link from "next/link";

import { ROUTES } from "@/config/constants";
import type { IssueRow } from "@/lib/drizzle/schema";
import {
  ProblemSeverityBadge,
  ProblemStatusBadge,
  type ProblemListEntry,
} from "@/modules/problems";
import { PresenceDot, type UserListEntry } from "@/modules/users";
import { cn } from "@/utils/cn";
import type {
  BackupSummary,
  DashboardCounts,
  LabelledCount,
  SeriesPoint,
} from "../repositories/dashboard.repository";
import type { StockSummary } from "../services/dashboard.service";
import type { HealthReport } from "../services/system-health";
import {
  BarChart,
  BreakdownBars,
  Metric,
  MetricGrid,
  Widget,
  WidgetEmpty,
  WidgetForbidden,
} from "./dashboard-primitives";

/**
 * Dashboard widgets.
 *
 * All server components. Every number arrives already computed from the
 * service, so none of these need state, effects or client JavaScript — the
 * whole page ships as HTML.
 */

function formatDateTime(value: Date | string | null): string {
  return value
    ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";
}

function relativeAge(value: Date | null, now: Date): string {
  if (!value) return "never";

  const hours = (now.getTime() - new Date(value).getTime()) / 3_600_000;

  if (hours < 1) return "under an hour ago";
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function AccountsWidget({ counts }: { counts: DashboardCounts["accounts"] }) {
  return (
    <Widget title="Accounts" icon={Layers}>
      <MetricGrid>
        <Metric label="Total" value={counts.total} />
        <Metric label="Healthy" value={counts.healthy} tone="success" />
        <Metric
          label="With problems"
          value={counts.withProblems}
          tone={counts.withProblems > 0 ? "danger" : "muted"}
        />
        <Metric label="Archived" value={counts.archived} tone="muted" />
      </MetricGrid>
    </Widget>
  );
}

export function ProfilesWidget({ counts }: { counts: DashboardCounts["profiles"] }) {
  return (
    <Widget title="Profiles" icon={Layers}>
      <MetricGrid>
        <Metric label="Total" value={counts.total} />
        <Metric label="Available" value={counts.available} tone="success" />
        <Metric label="Reserved" value={counts.reserved} />
        <Metric label="Sold" value={counts.sold} />
        <Metric label="Expiring soon" value={counts.expiringSoon} tone="warning" />
        <Metric label="Expired" value={counts.expired} tone="danger" />
      </MetricGrid>
    </Widget>
  );
}

export function CustomersWidget({ counts }: { counts: DashboardCounts["customers"] }) {
  return (
    <Widget
      title="Customers"
      icon={UsersIcon}
      action={
        <Link href={ROUTES.CUSTOMERS} className="text-caption text-primary hover:underline">
          View all
        </Link>
      }
    >
      <MetricGrid>
        <Metric label="Total" value={counts.total} />
        <Metric
          label="Active"
          value={counts.active}
          tone="success"
          hint="holds a live subscription"
        />
        <Metric label="Blocked" value={counts.blocked} tone="danger" />
        <Metric label="Archived" value={counts.archived} tone="muted" />
      </MetricGrid>
    </Widget>
  );
}

export function ProblemsCountsWidget({ counts }: { counts: DashboardCounts["problems"] }) {
  return (
    <Widget
      title="Problems"
      icon={TriangleAlert}
      action={
        <Link href={ROUTES.PROBLEMS} className="text-caption text-primary hover:underline">
          View all
        </Link>
      }
    >
      <MetricGrid>
        <Metric label="Open" value={counts.open} tone={counts.open > 0 ? "danger" : "muted"} />
        <Metric label="In progress" value={counts.inProgress} />
        <Metric label="Waiting" value={counts.waiting} tone="warning" />
        <Metric label="Resolved today" value={counts.resolvedToday} tone="success" />
        <Metric
          label="Critical"
          value={counts.critical}
          tone={counts.critical > 0 ? "danger" : "muted"}
        />
      </MetricGrid>
    </Widget>
  );
}

export function QuickPrepareWidget({ counts }: { counts: DashboardCounts["prepared"] }) {
  return (
    <Widget title="Quick Prepare" icon={Zap} description="Profiles sold, from profile events">
      <MetricGrid>
        <Metric label="Today" value={counts.today} />
        <Metric label="Yesterday" value={counts.yesterday} />
        <Metric label="This week" value={counts.thisWeek} />
        <Metric label="This month" value={counts.thisMonth} />
      </MetricGrid>
    </Widget>
  );
}

export function ExpirationWidget({ counts }: { counts: DashboardCounts["expirations"] }) {
  const nothing = counts.today + counts.tomorrow + counts.withinSevenDays + counts.expired === 0;

  return (
    <Widget
      title="Expirations"
      icon={CalendarClock}
      description="Read from expiration_date, never from a stored status"
    >
      {nothing ? (
        <WidgetEmpty message="No profiles are approaching expiry." />
      ) : (
        <MetricGrid>
          <Metric label="Today" value={counts.today} tone="danger" />
          <Metric label="Tomorrow" value={counts.tomorrow} tone="warning" />
          <Metric label="Within 3 days" value={counts.withinThreeDays} tone="warning" />
          <Metric label="Within 7 days" value={counts.withinSevenDays} />
          <Metric label="Already expired" value={counts.expired} tone="danger" />
        </MetricGrid>
      )}
    </Widget>
  );
}

/**
 * Revenue.
 *
 * Orders do not exist — ADR-005 Decision 1 deferred the table, and nothing in
 * the database records money. The M09 brief is explicit: do not invent revenue.
 * This widget states the gap rather than showing a zero, because a zero would
 * read as "no sales" instead of "not built".
 */
export function RevenueWidget() {
  return (
    <Widget title="Revenue" icon={Wallet}>
      <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border px-4 py-8 text-center">
        <ShoppingCart className="size-5 text-foreground-subtle" aria-hidden="true" />
        <p className="text-caption text-foreground-muted">Orders module not implemented.</p>
        <p className="max-w-xs text-caption text-foreground-subtle">
          No table records money yet, so any figure shown here would be invented.
        </p>
      </div>
    </Widget>
  );
}

export function HealthWidget({ health }: { health: HealthReport | null }) {
  if (!health) {
    return (
      <Widget title="System health" icon={HeartPulse}>
        <WidgetForbidden />
      </Widget>
    );
  }

  const tone =
    health.level === "green"
      ? "border-success/30 bg-success-subtle text-success"
      : health.level === "yellow"
        ? "border-warning/30 bg-warning-subtle text-warning"
        : "border-danger/30 bg-danger-subtle text-danger";

  const label =
    health.level === "green"
      ? "All systems healthy"
      : health.level === "yellow"
        ? "Attention needed"
        : "Action required";

  return (
    <Widget title="System health" icon={HeartPulse}>
      <div className={cn("flex items-center gap-2.5 rounded-md border px-4 py-3", tone)}>
        <span
          className={cn(
            "size-2.5 shrink-0 rounded-full",
            health.level === "green"
              ? "bg-success"
              : health.level === "yellow"
                ? "bg-warning"
                : "bg-danger",
          )}
          aria-hidden="true"
        />
        <span className="text-description font-medium">{label}</span>
      </div>

      <ul className="flex flex-col gap-1.5">
        {health.findings.map((finding) => (
          <li key={finding.message} className="flex items-start gap-2 text-caption">
            {finding.level === "green" ? (
              <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
            ) : (
              <TriangleAlert
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  finding.level === "red" ? "text-danger" : "text-warning",
                )}
                aria-hidden="true"
              />
            )}
            <span className="text-foreground-muted">{finding.message}</span>
          </li>
        ))}
      </ul>
    </Widget>
  );
}

export function StockWidget({ stock }: { stock: StockSummary | null }) {
  if (!stock) {
    return (
      <Widget title="Smart stock" icon={Layers}>
        <WidgetForbidden />
      </Widget>
    );
  }

  return (
    <Widget
      title="Smart stock"
      icon={Layers}
      description="Availability computed with evaluateAllocation — problem accounts excluded"
    >
      {stock.lowStock ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning-subtle px-4 py-2.5 text-caption text-warning"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          Low stock — {stock.totalAllocatable} profile{stock.totalAllocatable === 1 ? "" : "s"}{" "}
          allocatable.
        </div>
      ) : null}

      {stock.top.length === 0 ? (
        <WidgetEmpty message="No allocatable stock right now." />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {stock.top.map((entry) => (
            <li
              key={entry.accountId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-secondary px-3 py-2 text-caption"
            >
              <Link
                href={`${ROUTES.ACCOUNTS}/${entry.accountId}`}
                className="truncate text-foreground hover:text-primary"
              >
                {entry.email}
              </Link>
              <span className="text-foreground-subtle">
                {entry.allocatable}/{entry.total} free
              </span>
            </li>
          ))}
        </ul>
      )}

      {stock.excludedForProblems > 0 ? (
        <p className="text-caption text-foreground-subtle">
          {stock.excludedForProblems} account{stock.excludedForProblems === 1 ? "" : "s"} excluded
          for open problems.
        </p>
      ) : null}
    </Widget>
  );
}

export function OnlineUsersWidget({ users }: { users: readonly UserListEntry[] | null }) {
  if (!users) {
    return (
      <Widget title="Who's online" icon={UsersIcon}>
        <WidgetForbidden />
      </Widget>
    );
  }

  return (
    <Widget
      title="Who's online"
      icon={UsersIcon}
      description="Presence derived from Supabase sessions"
    >
      {users.length === 0 ? (
        <WidgetEmpty message="Nobody is active right now." />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {users.map((entry) => (
            <li
              key={entry.user.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-secondary px-3 py-2 text-caption"
            >
              <Link
                href={`${ROUTES.USERS}/${entry.user.id}`}
                className="text-foreground hover:text-primary"
              >
                {entry.user.name}
              </Link>
              <span className="flex items-center gap-2 text-foreground-subtle">
                <PresenceDot presence={entry.presence} />
                {entry.lastActiveAt ? formatDateTime(entry.lastActiveAt) : "—"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

export function UsersCountsWidget({
  counts,
  online,
}: {
  counts: DashboardCounts["users"] | null;
  online: number | null;
}) {
  if (!counts) {
    return (
      <Widget title="Users" icon={UsersIcon}>
        <WidgetForbidden />
      </Widget>
    );
  }

  return (
    <Widget title="Users" icon={UsersIcon}>
      <MetricGrid>
        <Metric label="Active" value={counts.active} tone="success" />
        <Metric label="Online" value={online ?? 0} />
        <Metric label="Suspended" value={counts.suspended} tone="warning" />
        <Metric label="Disabled" value={counts.disabled} tone="danger" />
      </MetricGrid>
    </Widget>
  );
}

export function BackupWidget({ backups, now }: { backups: BackupSummary | null; now: Date }) {
  if (!backups) {
    return (
      <Widget title="Backups" icon={DatabaseBackup}>
        <WidgetForbidden />
      </Widget>
    );
  }

  return (
    <Widget
      title="Backups"
      icon={DatabaseBackup}
      action={
        <Link href={ROUTES.BACKUPS} className="text-caption text-primary hover:underline">
          View all
        </Link>
      }
    >
      {!backups.lastBackupAt ? (
        <WidgetEmpty message="No backup has ever completed." />
      ) : (
        <MetricGrid>
          <Metric label="Last backup" value={relativeAge(backups.lastBackupAt, now)} />
          <Metric label="Last snapshot" value={relativeAge(backups.lastSnapshotAt, now)} />
          <Metric
            label="Integrity"
            value={backups.lastChecksumVerified ? "Verified" : "Unverified"}
            tone={backups.lastChecksumVerified ? "success" : "warning"}
          />
          <Metric
            label="Size"
            value={
              backups.lastSizeBytes === null
                ? "—"
                : backups.lastSizeBytes < 1024 * 1024
                  ? `${(backups.lastSizeBytes / 1024).toFixed(1)} KB`
                  : `${(backups.lastSizeBytes / 1024 / 1024).toFixed(1)} MB`
            }
          />
          <Metric
            label="Duration"
            value={
              backups.lastDurationMs === null
                ? "—"
                : `${(backups.lastDurationMs / 1000).toFixed(1)}s`
            }
          />
          <Metric
            label="Failed"
            value={backups.failed}
            tone={backups.failed > 0 ? "danger" : "muted"}
          />
        </MetricGrid>
      )}
    </Widget>
  );
}

export function ProblemsListWidget({
  title,
  description,
  items,
  emptyMessage,
}: {
  title: string;
  description?: string;
  items: readonly ProblemListEntry[];
  emptyMessage: string;
}) {
  return (
    <Widget title={title} description={description} icon={TriangleAlert}>
      {items.length === 0 ? (
        <WidgetEmpty message={emptyMessage} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((entry) => (
            <li key={entry.problem.id}>
              <Link
                href={`${ROUTES.PROBLEMS}/${entry.problem.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-secondary px-3 py-2 transition-colors hover:bg-surface-raised"
              >
                <span className="truncate text-caption text-foreground">{entry.accountEmail}</span>
                <span className="flex items-center gap-2">
                  <ProblemSeverityBadge severity={entry.problem.severity} />
                  <ProblemStatusBadge status={entry.problem.status} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

export function ReopenedWidget({ items }: { items: readonly IssueRow[] }) {
  return (
    <Widget title="Reopened problems" icon={TriangleAlert} description="Faults that came back">
      {items.length === 0 ? (
        <WidgetEmpty message="Nothing has been reopened." />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((problem) => (
            <li key={problem.id}>
              <Link
                href={`${ROUTES.PROBLEMS}/${problem.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-secondary px-3 py-2 text-caption transition-colors hover:bg-surface-raised"
              >
                <span className="truncate text-foreground">
                  {problem.issueType.replace(/_/g, " ")}
                </span>
                <span className="text-warning">reopened {problem.reopenCount}×</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

const SEVERITY_TONE: Record<string, string> = {
  critical: "bg-danger",
  high: "bg-warning",
  medium: "bg-primary",
  low: "bg-neutral",
};

export function ChartsWidget({
  accounts,
  customers,
  severity,
  backups,
  canSeeBackups,
}: {
  accounts: readonly SeriesPoint[];
  customers: readonly SeriesPoint[];
  severity: readonly LabelledCount[];
  backups: readonly SeriesPoint[];
  canSeeBackups: boolean;
}) {
  return (
    <>
      <Widget title="Accounts created" icon={ChartColumn} description="Last 30 days">
        <BarChart points={accounts} label="Accounts created per day over the last 30 days" />
      </Widget>

      <Widget title="Customers added" icon={ChartColumn} description="Last 30 days">
        <BarChart points={customers} label="Customers added per day over the last 30 days" />
      </Widget>

      <Widget title="Open problems by severity" icon={ChartColumn}>
        <BreakdownBars items={severity} toneFor={(label) => SEVERITY_TONE[label] ?? "bg-primary"} />
      </Widget>

      {canSeeBackups ? (
        <Widget title="Backups taken" icon={ChartColumn} description="Last 30 days">
          <BarChart points={backups} label="Backups taken per day over the last 30 days" />
        </Widget>
      ) : null}
    </>
  );
}

export function ActivityWidget({
  entries,
}: {
  entries: readonly {
    id: string;
    source: string;
    action: string;
    entity: string | null;
    actorName: string | null;
    createdAt: Date;
  }[];
}) {
  return (
    <Widget
      title="Recent activity"
      icon={Activity}
      description="Audit entries, profile events and sign-ins, newest first"
    >
      {entries.length === 0 ? (
        <WidgetEmpty message="Nothing has happened yet." />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <li
              key={`${entry.source}-${entry.id}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-secondary px-3 py-2 text-caption"
            >
              <span className="flex items-center gap-2 text-foreground">
                <span className="rounded bg-surface-raised px-1.5 py-0.5 text-foreground-subtle">
                  {entry.source}
                </span>
                {entry.action.replace(/_/g, " ")}
                {entry.entity ? (
                  <span className="text-foreground-subtle">· {entry.entity}</span>
                ) : null}
              </span>
              <span className="text-foreground-subtle">
                {entry.actorName ?? "System"} · {formatDateTime(entry.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}
