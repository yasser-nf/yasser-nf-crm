import { CalendarClock, CircleAlert, CircleCheck, Archive, LoaderCircle } from "lucide-react";

import type { BackupSummary } from "../services/backup.service";

/**
 * The Backups page summary (M07). Server-rendered from `backupService.summary`
 * — every figure is read, none is assumed; a failed read never reaches this
 * component, the page shows an error instead.
 *
 * The schedule states plainly whether anything will actually FIRE it: a
 * configured frequency with no scheduler trigger is shown as not running,
 * because claiming automatic backups that never happen is how systems end up
 * with none.
 */

export function utc(value: Date | string | null): string {
  return value ? `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC` : "—";
}

export const FREQUENCY_LABELS: Record<string, string> = {
  off: "Off",
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly (Mondays)",
  monthly: "Monthly (the 1st)",
};

function Card({
  icon: Icon,
  label,
  value,
  detail,
  tone = "text-foreground",
}: {
  icon: typeof CircleCheck;
  label: string;
  value: string;
  detail?: string | undefined;
  tone?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4">
      <span className="flex items-center gap-2 text-caption text-foreground-subtle">
        <Icon className="size-3.5" aria-hidden="true" />
        {label}
      </span>
      <span className={`text-card-title ${tone}`}>{value}</span>
      {detail ? <span className="text-caption text-foreground-muted">{detail}</span> : null}
    </div>
  );
}

export function BackupSummaryPanel({
  summary,
  schedulerConfigured,
}: {
  summary: BackupSummary;
  /** CRON_SECRET and storage configured — the endpoint can accept a trigger. */
  schedulerConfigured: boolean;
}) {
  const { schedule, retention } = summary.settings;
  const scheduleOn = schedule.frequency !== "off";
  const at =
    schedule.frequency === "hourly"
      ? "on the hour"
      : `at ${String(schedule.hourUtc).padStart(2, "0")}:00 UTC`;

  return (
    <section aria-label="Backup summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Card
        icon={CircleCheck}
        label="Last successful backup"
        value={summary.lastSuccessful ? utc(summary.lastSuccessful.createdAt) : "None yet"}
        detail={
          summary.lastSuccessful ? summary.lastSuccessful.name : "Create one to protect the data."
        }
        tone={summary.lastSuccessful ? "text-foreground" : "text-warning"}
      />
      <Card
        icon={CircleAlert}
        label="Last failed backup"
        value={summary.lastFailed ? utc(summary.lastFailed.createdAt) : "None"}
        detail={summary.lastFailed ? summary.lastFailed.name : undefined}
        tone={summary.lastFailed ? "text-danger" : "text-foreground"}
      />
      <Card
        icon={CalendarClock}
        label="Automatic backups"
        value={
          !scheduleOn
            ? "Off"
            : schedulerConfigured
              ? `${FREQUENCY_LABELS[schedule.frequency] ?? schedule.frequency}, ${at}`
              : "Not running"
        }
        detail={
          !scheduleOn
            ? "Turn on a schedule in Settings → Backups."
            : schedulerConfigured
              ? `Next slot ${utc(summary.nextScheduledAt)} — if the scheduler calls in.`
              : `${FREQUENCY_LABELS[schedule.frequency]} is set, but no scheduler trigger is configured (CRON_SECRET).`
        }
        tone={scheduleOn && !schedulerConfigured ? "text-warning" : "text-foreground"}
      />
      <Card
        icon={summary.running > 0 ? LoaderCircle : Archive}
        label="Stored backups"
        value={`${summary.successfulCount} successful`}
        detail={`${summary.totalCount} in total · keeping the last ${retention.keepLast} (restore points and snapshots are never pruned)${
          summary.running > 0 ? ` · ${summary.running} in progress` : ""
        }`}
      />
    </section>
  );
}
