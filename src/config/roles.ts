/**
 * User roles.
 *
 * ADR-003: M01 defines roles as types only. No role is persisted yet, because
 * 03_DATABASE.md is empty and the users table is undefined. Route protection in
 * M01 is authenticated-versus-guest only.
 *
 * When the database document exists, the storage location is added here and the
 * permission checks below become enforceable. The shape does not change.
 */

export const USER_ROLES = {
  SUPER_ADMIN: "super_admin",
  WORKER: "worker",
} as const;

export type UserRole = (typeof USER_ROLES)[keyof typeof USER_ROLES];

/**
 * Capabilities a role may exercise.
 *
 * 01_MASTER_RULES.md states what a Worker cannot do. Expressing it as an
 * allow-list rather than a deny-list means a new capability defaults to denied
 * for Workers instead of accidentally being granted.
 */
export const PERMISSIONS = {
  DELETE_ACCOUNTS: "delete_accounts",
  MANAGE_USERS: "manage_users",
  ACCESS_SETTINGS: "access_settings",
  ACCESS_BACKUPS: "access_backups",
  VIEW_SYSTEM_INFORMATION: "view_system_information",
  VIEW_LOGS: "view_logs",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  [USER_ROLES.SUPER_ADMIN]: [
    PERMISSIONS.DELETE_ACCOUNTS,
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.ACCESS_SETTINGS,
    PERMISSIONS.ACCESS_BACKUPS,
    PERMISSIONS.VIEW_SYSTEM_INFORMATION,
    PERMISSIONS.VIEW_LOGS,
  ],
  [USER_ROLES.WORKER]: [],
};

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const ROLE_LABELS: Record<UserRole, string> = {
  [USER_ROLES.SUPER_ADMIN]: "Super Admin",
  [USER_ROLES.WORKER]: "Worker",
};
