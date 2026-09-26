import type { BackupFrequency } from "../validation/backup.schema";

/**
 * When an automatic backup is due (M07). Pure: the caller supplies `now`.
 *
 * SLOTS, NOT INTERVALS. Each frequency defines a recurring instant, in UTC:
 *
 *   hourly    the start of every hour
 *   daily     every day at `hourUtc`:00
 *   weekly    every Monday at `hourUtc`:00
 *   monthly   the 1st of every month at `hourUtc`:00
 *
 * A backup is due when the latest successful scheduled backup was taken
 * before the most recent slot. That makes the trigger IDEMPOTENT: the
 * scheduler endpoint can be called once a day, once an hour or every five
 * minutes, retried, or called twice at once, and each slot still produces one
 * backup. It also makes a missed slot self-healing — the next call catches up
 * with one backup, not a burst of them.
 *
 * Everything is UTC, explicitly: `hourUtc` is a UTC hour, and slot arithmetic
 * uses Date.UTC, so neither the server's time zone nor daylight saving moves a
 * slot.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function clampHour(hourUtc: number): number {
  return Number.isInteger(hourUtc) && hourUtc >= 0 && hourUtc <= 23 ? hourUtc : 0;
}

/** The most recent slot at or before `now`, or null when the schedule is off. */
export function latestSlot(frequency: BackupFrequency, hourUtc: number, now: Date): Date | null {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const date = now.getUTCDate();
  const hour = clampHour(hourUtc);

  switch (frequency) {
    case "off":
      return null;

    case "hourly":
      return new Date(Date.UTC(year, month, date, now.getUTCHours()));

    case "daily": {
      const today = Date.UTC(year, month, date, hour);
      return new Date(now.getTime() >= today ? today : today - DAY);
    }

    case "weekly": {
      /* getUTCDay: Sunday 0 … Saturday 6. Days since the most recent Monday. */
      const sinceMonday = (now.getUTCDay() + 6) % 7;
      const thisWeek = Date.UTC(year, month, date - sinceMonday, hour);
      return new Date(now.getTime() >= thisWeek ? thisWeek : thisWeek - 7 * DAY);
    }

    case "monthly": {
      const thisMonth = Date.UTC(year, month, 1, hour);
      return new Date(now.getTime() >= thisMonth ? thisMonth : Date.UTC(year, month - 1, 1, hour));
    }
  }
}

/** Whether a scheduled backup should run now. */
export function isScheduledBackupDue(
  frequency: BackupFrequency,
  hourUtc: number,
  lastSuccessAt: Date | null,
  now: Date,
): boolean {
  const slot = latestSlot(frequency, hourUtc, now);

  if (slot === null) {
    return false;
  }

  return lastSuccessAt === null || lastSuccessAt.getTime() < slot.getTime();
}

/** The next slot after `now`, for display ("next backup at …"). */
export function nextSlot(frequency: BackupFrequency, hourUtc: number, now: Date): Date | null {
  const slot = latestSlot(frequency, hourUtc, now);

  if (slot === null) {
    return null;
  }

  switch (frequency) {
    case "hourly":
      return new Date(slot.getTime() + HOUR);
    case "daily":
      return new Date(slot.getTime() + DAY);
    case "weekly":
      return new Date(slot.getTime() + 7 * DAY);
    case "monthly":
      return new Date(
        Date.UTC(slot.getUTCFullYear(), slot.getUTCMonth() + 1, 1, slot.getUTCHours()),
      );
    default:
      return null;
  }
}

/** A backup still `running` after this long has lost its process. */
export const INTERRUPTED_AFTER_MS = 30 * 60 * 1000;
