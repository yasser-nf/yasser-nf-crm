import { z } from "zod";

/**
 * Backup configuration.
 *
 * Defined here rather than in the backups module, which is a change from
 * ADR-009 Decision 6 and is recorded in ADR-012 Decision 3.
 *
 * The reason is a real one, not tidiness: the backups module reads the settings
 * row through `settingsRepository`, so `settings → backups` would close a
 * circular import between two module barrels. It did, and the symptom was
 * `backupSettingsSchema` evaluating to `undefined` depending on which module
 * loaded first — a failure that appears in one test file and not another.
 *
 * Making Settings own every configuration shape resolves it and matches what
 * M11 asks for anyway: business modules consume settings, they never own them.
 * `modules/backups` re-exports these, so nothing that already imported them
 * changed.
 */

/** Frequencies. `hourly` survives from four LOCKED documents — ADR-009 D3. */
export const backupFrequencySchema = z.enum(["off", "hourly", "daily", "weekly", "monthly"]);

export const backupScheduleSchema = z.object({
  frequency: backupFrequencySchema.default("off"),
  /** Hour of day, 0–23, UTC. Ignored when the frequency is hourly or off. */
  hourUtc: z.number().int().min(0).max(23).default(2),
});

export const retentionPolicySchema = z.object({
  keepLast: z.number().int().min(1).max(365).default(30),
});

export const backupSettingsSchema = z.object({
  schedule: backupScheduleSchema.default(() => backupScheduleSchema.parse({})),
  retention: retentionPolicySchema.default(() => retentionPolicySchema.parse({})),
});

export type BackupFrequency = z.infer<typeof backupFrequencySchema>;
export type BackupSchedule = z.infer<typeof backupScheduleSchema>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type BackupSettings = z.infer<typeof backupSettingsSchema>;

/**
 * The shape of `settings.values`.
 *
 * ADR-012 Decision 3: settings stay in the singleton jsonb column rather than
 * being promoted to typed columns. Roughly forty settings across six categories
 * would otherwise mean forty columns on a one-row table and a migration for
 * every new preference — including a change of default. Zod gives the same
 * guarantees at the boundary where the value is read and written, which is the
 * only place it is used.
 *
 * This resolves the "revisit when settings outgrow backups" note in ADR-009
 * Decision 6.
 *
 * Every category has a default, so a fresh database reads as fully configured
 * rather than as a page of empty fields.
 */

export const generalSettingsSchema = z.object({
  applicationName: z.string().trim().min(1).max(80).default("Yasser NF CRM"),
  /* IANA name. Validated for shape, not against a list — the list moves. */
  timezone: z
    .string()
    .trim()
    .regex(/^[A-Za-z]+\/[A-Za-z_+-]+$|^UTC$/, "Use an IANA timezone such as Africa/Algiers")
    .default("Africa/Algiers"),
  dateFormat: z.enum(["iso", "european", "long"]).default("iso"),
  language: z.enum(["en"]).default("en"),
  currency: z.enum(["DZD", "EUR", "USD"]).default("DZD"),
});

/**
 * Company details.
 *
 * Every field is optional and defaults to empty. A CRM is usable before anyone
 * fills in a postal address, and forcing one at first launch would be a gate
 * with no purpose.
 */
export const companySettingsSchema = z.object({
  name: z.string().trim().max(120).default(""),
  logoUrl: z.union([z.string().trim().url(), z.literal("")]).default(""),
  address: z.string().trim().max(300).default(""),
  phone: z.string().trim().max(40).default(""),
  email: z.union([z.string().trim().email(), z.literal("")]).default(""),
  website: z.union([z.string().trim().url(), z.literal("")]).default(""),
  supportContact: z.string().trim().max(200).default(""),
});

export const securitySettingsSchema = z.object({
  sessionTimeoutMinutes: z.number().int().min(5).max(10_080).default(480),
  maxConcurrentSessions: z.number().int().min(1).max(50).default(5),
  passwordMinLength: z.number().int().min(8).max(128).default(12),
  forceLogoutOnRoleChange: z.boolean().default(true),
  inactiveUserDays: z.number().int().min(1).max(3650).default(90),
  /* Zero disables locking, which is why the floor is 0 rather than 1. */
  lockAfterFailedAttempts: z.number().int().min(0).max(20).default(10),
});

export const notificationSettingsSchema = z.object({
  email: z.boolean().default(false),
  problems: z.boolean().default(true),
  backups: z.boolean().default(true),
  quickPrepare: z.boolean().default(false),
  invitations: z.boolean().default(true),
  systemAlerts: z.boolean().default(true),
});

/**
 * The whole document.
 *
 * `backup` reuses the backups module's own schema rather than restating it.
 * ADR-009 Decision 6 gave that module ownership of its configuration shape, and
 * a second definition here would be the duplication M11 forbids — the two would
 * eventually disagree about a default.
 */
/*
 * Each category default is a function that parses `{}` through its own schema.
 *
 * Zod 4 types `.default()` against the *output* type, so passing a literal `{}`
 * is rejected even though every inner field has a default. Parsing `{}` lazily
 * produces exactly that output type and keeps the defaults declared once, on
 * the fields themselves, rather than repeated here.
 */
export const configurationSchema = z.object({
  general: generalSettingsSchema.default(() => generalSettingsSchema.parse({})),
  company: companySettingsSchema.default(() => companySettingsSchema.parse({})),
  security: securitySettingsSchema.default(() => securitySettingsSchema.parse({})),
  notifications: notificationSettingsSchema.default(() => notificationSettingsSchema.parse({})),
  backup: backupSettingsSchema.default(() => backupSettingsSchema.parse({})),
});

export type Configuration = z.infer<typeof configurationSchema>;
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;
export type CompanySettings = z.infer<typeof companySettingsSchema>;
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

/**
 * Reads whatever is in the column into a complete configuration.
 *
 * Never throws. The jsonb column is the one place a value can be arbitrary — a
 * hand-edited row, or a key written by an older build — and a settings page
 * that crashed on unexpected content would be unusable exactly when it is
 * needed to fix the problem. Unparseable input falls back to defaults.
 */
export function parseConfiguration(raw: unknown): Configuration {
  const parsed = configurationSchema.safeParse(raw ?? {});

  if (parsed.success) {
    return parsed.data;
  }

  /*
   * Salvage per category rather than discarding everything. One malformed
   * security value must not reset the company address.
   */
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  return {
    general:
      generalSettingsSchema.safeParse(source["general"] ?? {}).data ??
      generalSettingsSchema.parse({}),
    company:
      companySettingsSchema.safeParse(source["company"] ?? {}).data ??
      companySettingsSchema.parse({}),
    security:
      securitySettingsSchema.safeParse(source["security"] ?? {}).data ??
      securitySettingsSchema.parse({}),
    notifications:
      notificationSettingsSchema.safeParse(source["notifications"] ?? {}).data ??
      notificationSettingsSchema.parse({}),
    backup:
      backupSettingsSchema.safeParse(source["backup"] ?? {}).data ?? backupSettingsSchema.parse({}),
  };
}

/** The category schemas, for validating one section at a time. */
export const CATEGORY_SCHEMAS = {
  general: generalSettingsSchema,
  company: companySettingsSchema,
  security: securitySettingsSchema,
  notifications: notificationSettingsSchema,
  backup: backupSettingsSchema,
} as const;
