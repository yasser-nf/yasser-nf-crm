import { CalendarClock } from "lucide-react";

import { DEPLOYED_TRIGGER, formatHourUtc, type SchedulerStatus } from "../services/schedule";
import { FREQUENCY_LABELS, utc } from "./backup-summary";

/**
 * The automatic-backup scheduler, beside the settings that configure it.
 *
 * Four facts, kept apart: whether a schedule is set, whether a trigger is
 * configured to fire it, when the next slot falls, and whether a scheduled
 * backup has actually run. A configured trigger that has not fired yet says
 * exactly that — never "running".
 */
export function BackupSchedulerStatus({ status }: { status: SchedulerStatus }) {
  const label = FREQUENCY_LABELS[status.frequency] ?? status.frequency;
  const on = status.frequency !== "off";
  const notRunning = on && !status.configured;

  const value = !on
    ? "Off"
    : notRunning
      ? "Not running"
      : status.frequency === "hourly"
        ? label
        : `${label}, ${formatHourUtc(status.hourUtc)} UTC`;

  const lines: string[] = !on
    ? ["No automatic backups. Choose a schedule below."]
    : notRunning
      ? [
          `${label} is set, but no scheduler trigger is configured (CRON_SECRET): nothing calls ${DEPLOYED_TRIGGER.path}.`,
        ]
      : [
          `Scheduler configured — the cron calls ${DEPLOYED_TRIGGER.path} daily at ${formatHourUtc(DEPLOYED_TRIGGER.hourUtc)} UTC.`,
          `Next slot: ${utc(status.nextScheduledAt)}.`,
        ];

  if (on) {
    lines.push(
      status.lastScheduledAt
        ? `Last scheduled backup: ${utc(status.lastScheduledAt)}.`
        : "No scheduled backup has run yet.",
    );
  }

  return (
    <section
      aria-label="Automatic backups"
      className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4"
    >
      <span className="flex items-center gap-2 text-caption text-foreground-subtle">
        <CalendarClock className="size-3.5" aria-hidden="true" />
        Automatic backups
      </span>
      <span className={`text-card-title ${notRunning ? "text-warning" : "text-foreground"}`}>
        {value}
      </span>
      {lines.map((line) => (
        <span key={line} className="text-caption text-foreground-muted">
          {line}
        </span>
      ))}
    </section>
  );
}
