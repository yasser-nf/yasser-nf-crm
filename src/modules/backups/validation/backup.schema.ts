import { z } from "zod";

import { DEFAULT_KEEP_LAST, MAX_KEEP_LAST, MIN_KEEP_LAST } from "../services/retention";

/**
 * Backup configuration and inputs.
 *
 * The schedule and retention policy live inside `settings.values`, the singleton
 * jsonb column. 03_DATABASE.md's schema comment says specified settings should
 * eventually be promoted to typed columns; that is not done here because these
 * are the first two settings the project has ever specified, and a typed column
 * per setting in a singleton table would be a schema change per preference.
 * The Zod schema below gives the same guarantees at the application boundary,
 * which is where the value is read and written. Recorded in ADR-009 Decision 6.
 */

/**
 * Scheduled frequencies.
 *
 * `hourly` is required by four LOCKED documents; `weekly` and `monthly` by the
 * M07 brief. ADR-009 Decision 3 keeps all four rather than overriding either.
 * `off` is the default, because a CRM that silently began writing backups on a
 * schedule nobody chose would be a surprise, not a feature.
 */
export const backupFrequencySchema = z.enum(["off", "hourly", "daily", "weekly", "monthly"]);

export type BackupFrequency = z.infer<typeof backupFrequencySchema>;

export const backupScheduleSchema = z.object({
  frequency: backupFrequencySchema.default("off"),
  /** Hour of day, 0–23, UTC. Ignored when the frequency is hourly or off. */
  hourUtc: z.number().int().min(0).max(23).default(2),
});

export const retentionPolicySchema = z.object({
  keepLast: z.number().int().min(MIN_KEEP_LAST).max(MAX_KEEP_LAST).default(DEFAULT_KEEP_LAST),
});

export const backupSettingsSchema = z.object({
  schedule: backupScheduleSchema.default({ frequency: "off", hourUtc: 2 }),
  retention: retentionPolicySchema.default({ keepLast: DEFAULT_KEEP_LAST }),
});

export type BackupSettings = z.infer<typeof backupSettingsSchema>;
export type BackupSchedule = z.infer<typeof backupScheduleSchema>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

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
 * An imported file is untrusted input — 02_ARCHITECTURE.md requires validation
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
