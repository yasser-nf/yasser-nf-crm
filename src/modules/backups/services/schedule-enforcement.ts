import type { Enforcement } from "@/modules/settings";
import { DEPLOYED_TRIGGER, formatHourUtc, type SchedulerStatus } from "./schedule";

/**
 * What the Settings catalogue should say about the schedule settings, given the
 * scheduler as measured. The catalogue is static and declares them "pending
 * a scheduler trigger"; only the server knows whether one is configured.
 *
 * Configured is not the same as fully served. The deployed trigger calls once a
 * day at a fixed hour, so an hourly frequency, or a daily/weekly/monthly hour
 * other than the trigger's, is still stored but not honoured as written — and
 * the badge keeps saying so.
 */
export function scheduleEnforcement(
  status: SchedulerStatus,
): Readonly<Record<string, Enforcement>> {
  /* No trigger: the catalogue's own note ("awaiting a scheduler trigger") is the truth. */
  if (!status.configured) {
    return {};
  }

  const enforced: Enforcement = { state: "enforced" };
  const triggerAt = `${formatHourUtc(DEPLOYED_TRIGGER.hourUtc)} UTC`;
  const usesHour =
    status.frequency === "daily" || status.frequency === "weekly" || status.frequency === "monthly";

  return {
    "backup.schedule.frequency":
      status.frequency === "hourly"
        ? {
            state: "pending",
            awaiting: `an hourly trigger (the deployed cron calls once a day, at ${triggerAt})`,
          }
        : enforced,
    "backup.schedule.hourUtc":
      usesHour && status.hourUtc !== DEPLOYED_TRIGGER.hourUtc
        ? {
            state: "pending",
            awaiting: `a trigger at ${formatHourUtc(status.hourUtc)} UTC (the deployed cron calls at ${triggerAt}, so backups are taken then)`,
          }
        : enforced,
  };
}
