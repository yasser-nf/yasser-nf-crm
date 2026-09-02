import { PERMISSIONS, type Permission } from "@/config/roles";

/**
 * The report catalogue.
 *
 * Pure — no database, no `server-only` — so the definitions are unit testable
 * and can be read by both the server and the screens without duplicating a
 * list. The same split as `problem-lifecycle.ts` and `system-health.ts`.
 *
 * Every report declares the permission it needs. That is the whole of report
 * RBAC: there is no second list of "reports a Worker may see", because a second
 * list is a list that disagrees.
 */

export const REPORT_KEYS = [
  "accounts",
  "profiles",
  "customers",
  "problems",
  "users",
  "backups",
  "quick-prepare",
  "system-health",
  "audit-summary",
  "activity-summary",
] as const;

export type ReportKey = (typeof REPORT_KEYS)[number];

export type FilterKey =
  | "dateRange"
  | "status"
  | "severity"
  | "worker"
  | "customer"
  | "account"
  | "problemType"
  | "backupType";

export interface ReportColumn {
  readonly key: string;
  readonly label: string;
  /** Right-aligned and summed in exports. */
  readonly numeric?: boolean;
}

export interface ReportDefinition {
  readonly key: ReportKey;
  readonly title: string;
  readonly description: string;
  /** Null means every signed-in user may run it. */
  readonly permission: Permission | null;
  readonly filters: readonly FilterKey[];
  readonly searchable: boolean;
  /** Columns of the row-level dataset, which is what exports contain. */
  readonly columns: readonly ReportColumn[];
}

/**
 * Definitions.
 *
 * Permissions map onto what 01_MASTER_RULES.md already says a Worker cannot
 * reach: users, backups and system information. Everything operational — the
 * accounts, profiles, customers and problems they work with daily — stays
 * available, because a report is a read of data they can already see on its own
 * screen.
 *
 * The audit summary is administrative: audit logs name people and record
 * administrative actions, so it needs VIEW_LOGS.
 */
export const REPORT_DEFINITIONS: Record<ReportKey, ReportDefinition> = {
  accounts: {
    key: "accounts",
    title: "Accounts",
    description: "Stock distribution, health and allocation rate across every account.",
    permission: PERMISSIONS.VIEW_ACCOUNTS,
    filters: ["dateRange", "status", "account"],
    searchable: true,
    columns: [
      { key: "email", label: "Email" },
      { key: "status", label: "Status" },
      { key: "totalProfiles", label: "Profiles", numeric: true },
      { key: "availableProfiles", label: "Available", numeric: true },
      { key: "soldProfiles", label: "Sold", numeric: true },
      { key: "openProblems", label: "Open problems", numeric: true },
      { key: "createdAt", label: "Created" },
    ],
  },

  profiles: {
    key: "profiles",
    title: "Profiles",
    description: "Utilization, expiry and replacement across every profile.",
    permission: PERMISSIONS.VIEW_ACCOUNTS,
    filters: ["dateRange", "status", "account", "customer"],
    searchable: true,
    columns: [
      { key: "accountEmail", label: "Account" },
      { key: "profileNumber", label: "#", numeric: true },
      { key: "status", label: "Status" },
      { key: "customerName", label: "Customer" },
      { key: "expirationDate", label: "Expires" },
      { key: "replacements", label: "Replacements", numeric: true },
    ],
  },

  customers: {
    key: "customers",
    title: "Customers",
    description: "Growth, subscription distribution and replacement frequency.",
    permission: PERMISSIONS.VIEW_CUSTOMERS,
    filters: ["dateRange", "status", "customer"],
    searchable: true,
    columns: [
      { key: "name", label: "Name" },
      { key: "phoneNormalized", label: "Phone" },
      { key: "subscriptions", label: "Subscriptions", numeric: true },
      { key: "liveSubscriptions", label: "Live", numeric: true },
      { key: "replacements", label: "Replacements", numeric: true },
      { key: "status", label: "Status" },
      { key: "createdAt", label: "Joined" },
    ],
  },

  problems: {
    key: "problems",
    title: "Problems",
    description: "Resolution time, severity mix and reopen rate.",
    permission: PERMISSIONS.VIEW_PROBLEMS,
    filters: ["dateRange", "status", "severity", "worker", "problemType", "account"],
    searchable: true,
    columns: [
      { key: "accountEmail", label: "Account" },
      { key: "issueType", label: "Type" },
      { key: "severity", label: "Severity" },
      { key: "status", label: "Status" },
      { key: "assignedToName", label: "Assigned" },
      { key: "reopenCount", label: "Reopens", numeric: true },
      { key: "resolutionHours", label: "Resolved in (h)", numeric: true },
      { key: "createdAt", label: "Created" },
    ],
  },

  users: {
    key: "users",
    title: "Users",
    description: "Access, presence and last sign-in for every CRM user.",
    permission: PERMISSIONS.MANAGE_USERS,
    filters: ["dateRange", "status", "worker"],
    searchable: true,
    columns: [
      { key: "name", label: "Name" },
      { key: "email", label: "Email" },
      { key: "role", label: "Role" },
      { key: "status", label: "Status" },
      { key: "lastLoginAt", label: "Last login" },
      { key: "problemsAssigned", label: "Problems assigned", numeric: true },
    ],
  },

  backups: {
    key: "backups",
    title: "Backups",
    description: "Retention, storage usage and integrity status.",
    permission: PERMISSIONS.ACCESS_BACKUPS,
    filters: ["dateRange", "status", "backupType"],
    searchable: false,
    columns: [
      { key: "name", label: "Name" },
      { key: "type", label: "Type" },
      { key: "status", label: "Status" },
      { key: "sizeBytes", label: "Size (bytes)", numeric: true },
      { key: "checksumVerified", label: "Integrity" },
      { key: "createdAt", label: "Created" },
    ],
  },

  "quick-prepare": {
    key: "quick-prepare",
    title: "Quick Prepare",
    description: "Allocation volume and replacement activity over time.",
    permission: PERMISSIONS.PREPARE_SUBSCRIPTIONS,
    filters: ["dateRange", "worker", "account"],
    searchable: false,
    columns: [
      { key: "day", label: "Day" },
      { key: "allocations", label: "Allocations", numeric: true },
      { key: "replacements", label: "Replacements", numeric: true },
      { key: "extensions", label: "Extensions", numeric: true },
    ],
  },

  "system-health": {
    key: "system-health",
    title: "System health",
    description: "Overall status, critical problems, backup and database health.",
    permission: PERMISSIONS.VIEW_SYSTEM_INFORMATION,
    filters: [],
    searchable: false,
    columns: [
      { key: "check", label: "Check" },
      { key: "level", label: "Level" },
      { key: "detail", label: "Detail" },
    ],
  },

  "audit-summary": {
    key: "audit-summary",
    title: "Audit summary",
    description: "Audit entries grouped by entity, actor and day.",
    permission: PERMISSIONS.VIEW_LOGS,
    filters: ["dateRange", "worker"],
    searchable: false,
    columns: [
      { key: "day", label: "Day" },
      { key: "entity", label: "Entity" },
      { key: "action", label: "Action" },
      { key: "actorName", label: "Actor" },
      { key: "count", label: "Count", numeric: true },
    ],
  },

  "activity-summary": {
    key: "activity-summary",
    title: "Activity summary",
    description: "Sign-ins, problem activity and allocation activity by day.",
    permission: PERMISSIONS.VIEW_LOGS,
    filters: ["dateRange"],
    searchable: false,
    columns: [
      { key: "day", label: "Day" },
      { key: "logins", label: "Sign-ins", numeric: true },
      { key: "failedLogins", label: "Failed", numeric: true },
      { key: "problemEvents", label: "Problem activity", numeric: true },
      { key: "allocationEvents", label: "Allocations", numeric: true },
    ],
  },
};

export function isReportKey(value: string): value is ReportKey {
  return (REPORT_KEYS as readonly string[]).includes(value);
}

export function definitionFor(key: ReportKey): ReportDefinition {
  return REPORT_DEFINITIONS[key];
}

/**
 * Reports a role may run.
 *
 * Derived from the definitions rather than listed separately, so a report added
 * without a permission cannot quietly become visible to everyone — its
 * declared permission is the only thing that decides.
 */
export function reportsFor(hasPermission: (permission: Permission) => boolean): ReportDefinition[] {
  return REPORT_KEYS.map((key) => REPORT_DEFINITIONS[key]).filter(
    (definition) => definition.permission === null || hasPermission(definition.permission),
  );
}
