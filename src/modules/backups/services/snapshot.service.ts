import "server-only";

import type { BackupRow } from "@/lib/drizzle/schema";
import type { AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { backupService } from "./backup.service";
import type { BackupFrequency } from "../validation/backup.schema";

/**
 * Snapshot service.
 *
 * A System Snapshot is a complete backup taken deliberately before something
 * risky — a restore, a bulk edit, a migration. Mechanically it is a backup; what
 * differs is intent, and intent is what retention needs to know.
 *
 * Two consequences of the `snapshot` type, both in retention.ts:
 *
 *   it is always a restore point
 *   it is never pruned by the count-based policy
 *
 * Taking a snapshot before a restore is the reason a bad restore is survivable.
 * That is the only guard against the restore itself being the disaster.
 */
async function take(context: AuditContext): Promise<Result<BackupRow>> {
  return backupService.create({ type: "snapshot" }, context);
}

/**
 * Whether a scheduled backup is due.
 *
 * Pure decision, separated from any execution. ADR-009 Decision 2: M07 stores
 * the schedule and reports what is due, but nothing fires automatically — the
 * trigger mechanism was deferred. This is the function a cron entry would call
 * once that decision is made, and it is testable today without one.
 */
export function isDue(frequency: BackupFrequency, lastRunAt: Date | null, now: Date): boolean {
  if (frequency === "off") {
    return false;
  }

  if (!lastRunAt) {
    /* Never run: due immediately, so enabling a schedule produces a backup. */
    return true;
  }

  const elapsedMs = now.getTime() - lastRunAt.getTime();

  const HOUR = 60 * 60 * 1000;
  const intervals: Record<Exclude<BackupFrequency, "off">, number> = {
    hourly: HOUR,
    daily: 24 * HOUR,
    weekly: 7 * 24 * HOUR,
    monthly: 30 * 24 * HOUR,
  };

  return elapsedMs >= intervals[frequency];
}

export const snapshotService = { take, isDue } as const;
