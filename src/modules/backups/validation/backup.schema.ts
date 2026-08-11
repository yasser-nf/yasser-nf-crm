import { z } from "zod";

import {
  backupFrequencySchema,
  backupScheduleSchema,
  backupSettingsSchema,
  retentionPolicySchema,
  type BackupFrequency,
  type BackupSchedule,
  type BackupSettings,
  type RetentionPolicy,
} from "@/modules/settings";

/**
 * Backup configuration and inputs.
 *
 * The schedule and retention shapes moved to the settings module in M11 and
 * are re-exported here so every existing import keeps working. ADR-012
 * Decision 3 records why: the backups module reads the settings row, so
 * defining the shape here as well closed a circular import between the two
 * barrels. Settings owns every configuration shape; this module consumes it.
 */

export { backupFrequencySchema, backupScheduleSchema, backupSettingsSchema, retentionPolicySchema };

export type { BackupFrequency, BackupSchedule, BackupSettings, RetentionPolicy };

/** Applied to whatever is in the jsonb column, which may be anything at all. */
export function parseBackupSettings(raw: unknown): BackupSettings {
  const container = z.object({ backup: backupSettingsSchema.optional() }).safeParse(raw ?? {});

  if (!container.success || !container.data.backup) {
    return backupSettingsSchema.parse({});
  }

  return container.data.backup;
}

export const createBackupSchema = z.object({
  type: z.enum(["manual", "snapshot"]),
  note: z.string().trim().max(200).optional(),
});

export type CreateBackupInput = z.infer<typeof createBackupSchema>;

/**
 * The manifest, validated on import.
 *
 * An imported file is untrusted input â€” 02_ARCHITECTURE.md requires validation
 * at the boundary, and this is the boundary. A malformed manifest is rejected
 * before a single row is read.
 */
export const backupManifestSchema = z.object({
  formatVersion: z.number().int().min(1),
  createdAt: z.string().min(1),
  createdBy: z.string().nullable(),
  appVersion: z.string(),
  databaseVersion: z.string(),
  type: z.string(),
  tables: z.array(z.string()),
  rowCounts: z.record(z.string(), z.number().int().min(0)),
});

export const backupArtifactSchema = z.object({
  manifest: backupManifestSchema,
  data: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
