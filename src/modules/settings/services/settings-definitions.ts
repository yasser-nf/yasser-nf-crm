import { PERMISSIONS, type Permission } from "@/config/roles";

/**
 * The settings catalogue.
 *
 * Pure — no database, no `server-only` — so it is unit testable and readable by
 * both the server and the screens without a second list. The same shape as
 * `report-definitions.ts` in M10, for the same reason: one declaration drives
 * the forms, the search, the filters, the validation and the permissions, so a
 * setting cannot exist in one of those and not the others.
 *
 * This is what makes Settings the single source of configuration. A business
 * module consumes a value through `configurationService`; it never declares one.
 */

export const SETTINGS_CATEGORIES = [
  "general",
  "company",
  "security",
  "backups",
  "notifications",
  "system",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

/**
 * Whether the system currently acts on a setting.
 *
 * The M11 brief asks for settings the CRM cannot yet enforce, and the approved
 * decision was to store them honestly rather than omit them or pretend. This
 * field is how that honesty is expressed — every surface shows it, so a stored
 * password policy is never mistaken for an active security control.
 */
export type Enforcement =
  | { readonly state: "enforced" }
  | { readonly state: "external"; readonly by: string }
  | { readonly state: "pending"; readonly awaiting: string };

export const ENFORCED: Enforcement = { state: "enforced" };

export type SettingType = "text" | "email" | "url" | "number" | "boolean" | "select";

export interface SettingDefinition {
  readonly key: string;
  readonly category: SettingsCategory;
  readonly label: string;
  readonly description: string;
  readonly type: SettingType;
  readonly options?: readonly { value: string; label: string }[];
  readonly min?: number;
  readonly max?: number;
  readonly enforcement: Enforcement;
  /** Permission required to CHANGE it. Reading is governed separately. */
  readonly permission: Permission;
  /** Whether a Worker may see the value at all. */
  readonly readableByWorker: boolean;
}

/**
 * Every setting in the system.
 *
 * Notable omission: there is no `theme`. 01_MASTER_RULES.md and
 * 04_UI_GUIDELINES.md both fix the interface to dark and 04 explicitly forbids
 * a theme switcher — two LOCKED documents, one of them rank 1. ADR-012
 * Decision 1 records why the M11 brief's Theme entry was not built.
 */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  /* ---------------------------------------------------------------- */
  /* General                                                           */
  /* ---------------------------------------------------------------- */
  {
    key: "general.applicationName",
    category: "general",
    label: "Application name",
    description: "Shown in the browser tab and the sidebar.",
    type: "text",
    enforcement: ENFORCED,
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: true,
  },
  {
    key: "general.timezone",
    category: "general",
    label: "Timezone",
    description: "IANA timezone used when a date is displayed without one.",
    type: "text",
    enforcement: ENFORCED,
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: true,
  },
  {
    key: "general.dateFormat",
    category: "general",
    label: "Date format",
    description: "How dates are rendered across the CRM.",
    type: "select",
    options: [
      { value: "iso", label: "2026-08-11" },
      { value: "european", label: "11/08/2026" },
      { value: "long", label: "11 August 2026" },
    ],
    enforcement: ENFORCED,
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: true,
  },
  {
    key: "general.language",
    category: "general",
    label: "Language",
    description: "Interface language.",
    type: "select",
    options: [{ value: "en", label: "English" }],
    /* No i18n layer exists; every string in the application is English literal. */
    enforcement: { state: "pending", awaiting: "an internationalisation layer" },
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: true,
  },
  {
    key: "general.currency",
    category: "general",
    label: "Currency",
    description: "Currency used when money is displayed.",
    type: "select",
    options: [
      { value: "DZD", label: "Algerian dinar" },
      { value: "EUR", label: "Euro" },
      { value: "USD", label: "US dollar" },
    ],
    /* Nothing records money: ADR-005 Decision 1 deferred the orders table. */
    enforcement: { state: "pending", awaiting: "the orders module" },
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: true,
  },

  /* ---------------------------------------------------------------- */
  /* Company                                                           */
  /* ---------------------------------------------------------------- */
  {
    key: "company.name",
    category: "company",
    label: "Company name",
    description: "Appears on printed reports.",
    type: "text",
    enforcement: ENFORCED,
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: true,
  },
  {
    key: "company.logoUrl",
    category: "company",
    label: "Logo URL",
    description: "Displayed on printed reports. A URL, not an upload.",
    type: "url",
    enforcement: ENFORCED,
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: true,
  },
  {
    key: "company.address",
    category: "company",
    label: "Address",
    description: "Postal address.",
    type: "text",
    enforcement: ENFORCED,
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: true,
  },
  {
    key: "company.phone",
    category: "company",
    label: "Phone",
    description: "Main contact number.",
    type: "text",
    enforcement: ENFORCED,
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: true,
  },
  {
    key: "company.email",
    category: "company",
    label: "Email",
    description: "Main contact address.",
    type: "email",
    enforcement: ENFORCED,
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: true,
  },
  {
    key: "company.website",
    category: "company",
    label: "Website",
    description: "Public site.",
    type: "url",
    enforcement: ENFORCED,
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: true,
  },
  {
    key: "company.supportContact",
    category: "company",
    label: "Support contact",
    description: "Who staff contact when something breaks.",
    type: "text",
    enforcement: ENFORCED,
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: true,
  },

  /* ---------------------------------------------------------------- */
  /* Security                                                          */
  /* ---------------------------------------------------------------- */
  {
    key: "security.sessionTimeoutMinutes",
    category: "security",
    label: "Session timeout (minutes)",
    description: "How long a session may stay idle.",
    type: "number",
    min: 5,
    max: 10_080,
    /*
     * Supabase Auth issues and expires the JWT. The CRM can revoke a session
     * (M06) but cannot shorten a token's lifetime, so this value is recorded
     * and must be matched in the Supabase project settings to take effect.
     */
    enforcement: { state: "external", by: "Supabase Auth project settings" },
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: false,
  },
  {
    key: "security.maxConcurrentSessions",
    category: "security",
    label: "Maximum concurrent sessions",
    description: "Sessions one user may hold at once.",
    type: "number",
    min: 1,
    max: 50,
    enforcement: { state: "pending", awaiting: "enforcement in the sessions service" },
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: false,
  },
  {
    key: "security.passwordMinLength",
    category: "security",
    label: "Minimum password length",
    description: "Shortest password a user may choose.",
    type: "number",
    min: 8,
    max: 128,
    /*
     * ADR-008 Decision 2: the CRM never sees a password. Complexity is enforced
     * by Supabase Auth, which owns the credential store. Recording the intent
     * here without saying so would be the most dangerous kind of inert setting.
     */
    enforcement: { state: "external", by: "Supabase Auth password policy" },
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: false,
  },
  {
    key: "security.forceLogoutOnRoleChange",
    category: "security",
    label: "Force logout on role change",
    description: "Revoke every session when a user's role changes.",
    type: "boolean",
    enforcement: { state: "pending", awaiting: "enforcement in the users service" },
    permission: PERMISSIONS.MODIFY_PERMISSIONS,
    readableByWorker: false,
  },
  {
    key: "security.inactiveUserDays",
    category: "security",
    label: "Inactive user threshold (days)",
    description: "After this long without signing in, a user is reported as inactive.",
    type: "number",
    min: 1,
    max: 3650,
    enforcement: { state: "pending", awaiting: "a scheduled job" },
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: false,
  },
  {
    key: "security.lockAfterFailedAttempts",
    category: "security",
    label: "Lock after failed attempts",
    description: "Failed sign-ins before an account is locked. Zero disables locking.",
    type: "number",
    min: 0,
    max: 20,
    /* login_history records failures (M06); nothing acts on the count yet. */
    enforcement: { state: "pending", awaiting: "enforcement in the auth flow" },
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: false,
  },

  /* ---------------------------------------------------------------- */
  /* Backups — the schema is owned by the backups module (ADR-009 D6)  */
  /* ---------------------------------------------------------------- */
  {
    key: "backup.schedule.frequency",
    category: "backups",
    label: "Automatic schedule",
    description: "How often a backup should be taken.",
    type: "select",
    options: [
      { value: "off", label: "Off" },
      { value: "hourly", label: "Hourly" },
      { value: "daily", label: "Daily" },
      { value: "weekly", label: "Weekly" },
      { value: "monthly", label: "Monthly" },
    ],
    /* ADR-009 Decision 2: the schedule is stored and reported, never fired. */
    enforcement: { state: "pending", awaiting: "a scheduler trigger (ADR-009 D2)" },
    permission: PERMISSIONS.ACCESS_BACKUPS,
    readableByWorker: false,
  },
  {
    key: "backup.schedule.hourUtc",
    category: "backups",
    label: "Scheduled hour (UTC)",
    description: "Hour of day a daily, weekly or monthly backup runs.",
    type: "number",
    min: 0,
    max: 23,
    enforcement: { state: "pending", awaiting: "a scheduler trigger (ADR-009 D2)" },
    permission: PERMISSIONS.ACCESS_BACKUPS,
    readableByWorker: false,
  },
  {
    key: "backup.retention.keepLast",
    category: "backups",
    label: "Keep last N backups",
    description: "Older backups are pruned. Restore points and snapshots are never pruned.",
    type: "number",
    min: 1,
    max: 365,
    enforcement: ENFORCED,
    permission: PERMISSIONS.ACCESS_BACKUPS,
    readableByWorker: false,
  },

  /* ---------------------------------------------------------------- */
  /* Notifications                                                     */
  /* ---------------------------------------------------------------- */
  ...(
    [
      ["notifications.email", "Email notifications", "Send notifications by email at all."],
      [
        "notifications.problems",
        "Problem notifications",
        "Notify when a problem is reported or escalates.",
      ],
      [
        "notifications.backups",
        "Backup notifications",
        "Notify when a backup fails or an integrity check fails.",
      ],
      [
        "notifications.quickPrepare",
        "Quick Prepare notifications",
        "Notify on allocation and replacement activity.",
      ],
      [
        "notifications.invitations",
        "Invitation notifications",
        "Notify when a user invitation is sent or accepted.",
      ],
      [
        "notifications.systemAlerts",
        "System alerts",
        "Notify when overall system health turns red.",
      ],
    ] as const
  ).map(([key, label, description]): SettingDefinition => ({
    key,
    category: "notifications",
    label,
    description,
    type: "boolean",
    /*
     * ADR-005 Decision 1 deferred the notifications table and no sender is
     * configured, so every switch here is a stored preference awaiting a
     * delivery mechanism.
     */
    enforcement: { state: "pending", awaiting: "the notifications module" },
    permission: PERMISSIONS.ACCESS_SETTINGS,
    readableByWorker: false,
  })),
];

const BY_KEY = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

export function definitionForKey(key: string): SettingDefinition | null {
  return BY_KEY.get(key) ?? null;
}

export function definitionsForCategory(category: SettingsCategory): SettingDefinition[] {
  return SETTING_DEFINITIONS.filter((definition) => definition.category === category);
}

export function isSettingsCategory(value: string): value is SettingsCategory {
  return (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Search across every setting.
 *
 * Matches the key, label and description, so someone looking for "retention"
 * finds it whether they remember the label or the wording.
 */
export function searchDefinitions(query: string): SettingDefinition[] {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return [...SETTING_DEFINITIONS];
  }

  return SETTING_DEFINITIONS.filter((definition) =>
    `${definition.key} ${definition.label} ${definition.description}`
      .toLowerCase()
      .includes(needle),
  );
}

/** A short phrase explaining why a setting is not acted upon, or null when it is. */
export function enforcementNote(definition: SettingDefinition): string | null {
  switch (definition.enforcement.state) {
    case "enforced":
      return null;
    case "external":
      return `Recorded here; enforced by ${definition.enforcement.by}.`;
    case "pending":
      return `Stored but not yet enforced — awaiting ${definition.enforcement.awaiting}.`;
  }
}
