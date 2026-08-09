import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Database enums.
 *
 * Values are snake_case per 03_DATABASE.md's column naming rule. Display labels
 * belong in the UI layer, never in the database — renaming a label must not
 * require a migration.
 *
 * Every list here is fixed by a LOCKED document. ADR-005 Decision 2 records why
 * the competing lists in CURRENT_MILESTONE.md were rejected.
 */

/**
 * 01_MASTER_RULES.md and 03_DATABASE.md.
 *
 * Business rule carried by this enum: if an account is not `healthy`, ALL of its
 * profiles become unavailable. No exceptions. Enforced in the service layer,
 * because it is a rule about derived availability rather than stored state.
 */
export const accountStatusEnum = pgEnum("account_status", [
  "healthy",
  "payment_problem",
  "incorrect_password",
  "invalid_email",
  "something_went_wrong",
  "archived",
  "deleted",
]);

/**
 * 01_MASTER_RULES.md and 03_DATABASE.md.
 *
 * `expiring_soon` and `expired` are not set by any user action — they are
 * functions of expiration_date and the current date. M02 stores the values; the
 * milestone that owns expiry decides what transitions into them. Nothing in M02
 * writes either value.
 */
export const profileStatusEnum = pgEnum("profile_status", [
  "available",
  "reserved",
  "sold",
  "expiring_soon",
  "expired",
]);

/** 01_MASTER_RULES.md. Mirrors config/roles.ts, which already used these values. */
export const userRoleEnum = pgEnum("user_role", ["super_admin", "worker"]);

/**
 * Account state for a CRM user.
 *
 * M06 defines the semantics that were missing when this enum was created:
 *
 *   active     may authenticate and use the CRM
 *   suspended  may not authenticate; existing sessions are left alone, so
 *              lifting the suspension restores access without a new sign-in
 *   disabled   may not authenticate AND every session is revoked immediately
 *
 * `archived` is not a value here. It is `deleted_at`, derived rather than
 * stored, matching how customer status works — a stored `archived` could
 * disagree with the tombstone.
 *
 * `blocked` was NOT added. The M06 brief lists it, but gives it no semantics
 * distinct from suspended or disabled, and a third near-identical "cannot use
 * the system" state would be indistinguishable in practice. See
 * docs/USERS_MODULE.md.
 */
export const userStatusEnum = pgEnum("user_status", ["active", "suspended", "disabled"]);

/**
 * Profile history event types, from the M02 brief.
 *
 * The `data` jsonb column on profile_events carries per-event detail, so a new
 * event type that needs new fields does not require a schema change — only a new
 * value here.
 */
export const profileEventTypeEnum = pgEnum("profile_event_type", [
  "created",
  "sold",
  "replaced",
  "extended",
  "expired",
  "pin_changed",
  "name_changed",
  "customer_changed",
  "status_changed",
]);

/**
 * Audit actions.
 *
 * 01_MASTER_RULES.md: every important action must be logged, and the log is
 * immutable. An enum rather than free text so a typo cannot create a category
 * that silently hides events from a filter.
 */
export const auditActionEnum = pgEnum("audit_action", [
  "create",
  "update",
  "delete",
  "restore",
  "archive",
  "login",
  "logout",
]);

/**
 * Entities the audit log can describe.
 *
 * Deliberately excludes audit_logs itself — an audit entry about an audit entry
 * would be meaningless in an append-only table.
 */
export const auditEntityEnum = pgEnum("audit_entity", [
  "user",
  "customer",
  "account",
  "profile",
  "backup",
  "settings",
]);

/** 03_DATABASE.md backup strategy: hourly, daily, manual, restore point. */
export const backupTypeEnum = pgEnum("backup_type", ["hourly", "daily", "manual"]);

/**
 * Backup lifecycle.
 *
 * `verified` is distinct from `completed` because 01_MASTER_RULES.md requires
 * backups to be verifiable — a backup that exists but has never had its checksum
 * confirmed is not yet known to be restorable.
 */
export const backupStatusEnum = pgEnum("backup_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "verified",
]);
