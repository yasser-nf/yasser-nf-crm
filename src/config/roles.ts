/**
 * Roles and permissions.
 *
 * ADR-005 Decision 3 makes public.users.role authoritative. M04.9 wired
 * getCurrentUser to read it, so these checks are live rather than theoretical.
 *
 * M06 expanded this into the full permission matrix. Two roles only — the brief
 * is explicit that no others exist.
 */

export const USER_ROLES = {
  SUPER_ADMIN: "super_admin",
  WORKER: "worker",
} as const;

export type UserRole = (typeof USER_ROLES)[keyof typeof USER_ROLES];

/**
 * Every capability the application gates on.
 *
 * Named for the action rather than the screen. A permission tied to a page
 * stops meaning anything the moment the page moves, and authorization must
 * survive a redesign.
 */
export const PERMISSIONS = {
  /* Accounts */
  VIEW_ACCOUNTS: "view_accounts",
  CREATE_ACCOUNTS: "create_accounts",
  EDIT_ACCOUNTS: "edit_accounts",
  ARCHIVE_ACCOUNTS: "archive_accounts",
  DELETE_ACCOUNTS: "delete_accounts",

  /* Profiles */
  EDIT_PROFILE_NAMES: "edit_profile_names",
  EDIT_PROFILE_PINS: "edit_profile_pins",

  /* Allocation */
  PREPARE_SUBSCRIPTIONS: "prepare_subscriptions",
  REPLACE_ACCOUNTS: "replace_accounts",
  /*
   * Removing a sale, leaving the customer with nothing.
   *
   * Deliberately separate from REPLACE_ACCOUNTS, which Workers hold. Quick
   * Replace also ends an allocation, but it ends it by moving the customer onto
   * a working account — they keep the days they paid for. This ends it outright,
   * and it is the only action in the CRM that takes a live subscription away
   * without giving anything back.
   *
   * Absent from WORKER_PERMISSIONS, so it is Super Admin only. The allow-list
   * below means that is the default for anything new rather than something that
   * had to be remembered.
   */
  UNASSIGN_SALES: "unassign_sales",

  /* Customers */
  VIEW_CUSTOMERS: "view_customers",
  EDIT_CUSTOMER_NOTES: "edit_customer_notes",
  BLOCK_CUSTOMERS: "block_customers",
  ARCHIVE_CUSTOMERS: "archive_customers",

  /* Operations */
  SEARCH: "search",
  OPEN_WHATSAPP: "open_whatsapp",

  /*
   * Problems (M08).
   *
   * Three permissions rather than one, because the M08 brief splits Worker
   * access three ways: they may report, they may see everything, and they may
   * act only on what is assigned to them. Ownership is not expressible as a
   * permission — it depends on the row — so it is checked in the service and
   * MANAGE_PROBLEMS covers only what no Worker may ever do: delete, change
   * severity, and reassign a problem they do not own.
   */
  REPORT_PROBLEMS: "report_problems",
  VIEW_PROBLEMS: "view_problems",
  MANAGE_PROBLEMS: "manage_problems",

  /* Administration */
  MANAGE_USERS: "manage_users",
  MODIFY_PERMISSIONS: "modify_permissions",
  ACCESS_SETTINGS: "access_settings",
  ACCESS_BACKUPS: "access_backups",
  VIEW_SECURITY: "view_security",
  VIEW_LOGS: "view_logs",
  ACCESS_DEVELOPER_PAGES: "access_developer_pages",
  VIEW_SYSTEM_INFORMATION: "view_system_information",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * What a Worker may do.
 *
 * Taken verbatim from the M06 brief's "Workers may" list, extended once by the
 * M08 brief for problems. Expressed as an allow-list rather than a deny-list, so
 * a permission added later defaults to denied for Workers instead of being
 * silently granted — the direction a mistake should fail in.
 *
 * Adding to this list is a deliberate act, never a detail: M08 grants exactly
 * REPORT_PROBLEMS and VIEW_PROBLEMS, and deliberately not MANAGE_PROBLEMS.
 */
const WORKER_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.VIEW_ACCOUNTS,
  PERMISSIONS.VIEW_CUSTOMERS,
  PERMISSIONS.PREPARE_SUBSCRIPTIONS,
  PERMISSIONS.REPLACE_ACCOUNTS,
  PERMISSIONS.EDIT_PROFILE_NAMES,
  PERMISSIONS.EDIT_PROFILE_PINS,
  PERMISSIONS.EDIT_CUSTOMER_NOTES,
  PERMISSIONS.OPEN_WHATSAPP,
  PERMISSIONS.SEARCH,
  PERMISSIONS.REPORT_PROBLEMS,
  PERMISSIONS.VIEW_PROBLEMS,
];

/** Super Admin holds everything. Listed by derivation so it cannot drift. */
const ALL_PERMISSIONS = Object.values(PERMISSIONS);

const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  [USER_ROLES.SUPER_ADMIN]: ALL_PERMISSIONS,
  [USER_ROLES.WORKER]: WORKER_PERMISSIONS,
};

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Every permission a role holds. Used by the users screen to explain access. */
export function permissionsForRole(role: UserRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export const ROLE_LABELS: Record<UserRole, string> = {
  [USER_ROLES.SUPER_ADMIN]: "Super Admin",
  [USER_ROLES.WORKER]: "Worker",
};

/**
 * User status.
 *
 * `archived` is deliberately absent: it is `deleted_at`, derived rather than
 * stored, exactly as customer status works. Adding it here would let a row be
 * archived-but-not-deleted and disagree with itself.
 *
 * See docs/USERS_MODULE.md for why `blocked` was not added.
 */
export const USER_STATUSES = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DISABLED: "disabled",
} as const;

export type UserStatus = (typeof USER_STATUSES)[keyof typeof USER_STATUSES];

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  [USER_STATUSES.ACTIVE]: "Active",
  [USER_STATUSES.SUSPENDED]: "Suspended",
  [USER_STATUSES.DISABLED]: "Disabled",
};

/**
 * Whether a status permits using the CRM.
 *
 * Only `active` does. Suspended and disabled both deny; they differ in what
 * happens to existing sessions, which is a concern of the service that applies
 * them rather than of this predicate.
 */
export function statusAllowsAccess(status: UserStatus): boolean {
  return status === USER_STATUSES.ACTIVE;
}
