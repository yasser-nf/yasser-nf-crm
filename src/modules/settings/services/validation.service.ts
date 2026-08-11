import type { Configuration } from "../validation/configuration.schema";

/**
 * Cross-field validation.
 *
 * Pure, and separate from the Zod schemas on purpose. A schema validates one
 * field against its own rules; these are the rules that only make sense once
 * two fields are read together, which is what the M11 brief means by
 * "prevent invalid combinations".
 *
 * Returns problems rather than throwing, so the settings page can show every
 * conflict at once instead of one per save.
 */

export type IssueSeverity = "error" | "warning";

export interface ConfigurationIssue {
  readonly severity: IssueSeverity;
  /** Dotted key, matching the catalogue, so the UI can point at the field. */
  readonly key: string;
  readonly message: string;
}

/**
 * Checks a whole configuration.
 *
 * An `error` blocks the save. A `warning` does not — it describes a
 * combination that is legal but probably unintended, and refusing those would
 * make the page argue with someone who knows what they want.
 */
export function validateConfiguration(configuration: Configuration): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  const { security, backup, notifications, company } = configuration;

  /*
   * A schedule with nothing to keep would take a backup and immediately prune
   * it. Retention has a floor of 1, so this is only reachable if the floor
   * changes — asserted here so it fails loudly rather than silently deleting.
   */
  if (backup.schedule.frequency !== "off" && backup.retention.keepLast < 1) {
    issues.push({
      severity: "error",
      key: "backup.retention.keepLast",
      message: "A schedule is enabled but retention keeps nothing. Keep at least one backup.",
    });
  }

  /*
   * Hourly backups against a small retention count means the oldest surviving
   * backup is only hours old. Legal, and occasionally what somebody wants, but
   * it silently removes any ability to recover from a fault noticed a day
   * later.
   */
  if (backup.schedule.frequency === "hourly" && backup.retention.keepLast < 24) {
    issues.push({
      severity: "warning",
      key: "backup.retention.keepLast",
      message: `Hourly backups keeping only ${backup.retention.keepLast} means less than a day of history.`,
    });
  }

  /* Locking after one failure locks out anyone who mistypes once. */
  if (security.lockAfterFailedAttempts === 1) {
    issues.push({
      severity: "warning",
      key: "security.lockAfterFailedAttempts",
      message: "Locking after a single failed attempt will lock out anyone who mistypes.",
    });
  }

  if (security.lockAfterFailedAttempts === 0) {
    issues.push({
      severity: "warning",
      key: "security.lockAfterFailedAttempts",
      message: "Account locking is disabled. Failed sign-ins are recorded but never act.",
    });
  }

  /*
   * A session that outlives the inactivity threshold means "inactive" can never
   * be reached by anyone who stays signed in — the two settings contradict.
   */
  if (security.sessionTimeoutMinutes > security.inactiveUserDays * 24 * 60) {
    issues.push({
      severity: "error",
      key: "security.sessionTimeoutMinutes",
      message:
        "The session timeout is longer than the inactive-user threshold, so no session could ever be considered inactive.",
    });
  }

  /*
   * Every notification switch is inert without a delivery mechanism. Enabling
   * one while email is off is not wrong, but it does nothing at all.
   */
  const anyChannel =
    notifications.problems ||
    notifications.backups ||
    notifications.quickPrepare ||
    notifications.invitations ||
    notifications.systemAlerts;

  if (anyChannel && !notifications.email) {
    issues.push({
      severity: "warning",
      key: "notifications.email",
      message:
        "Notification types are enabled but email delivery is off, so nothing would be sent.",
    });
  }

  if (notifications.email && !company.email) {
    issues.push({
      severity: "warning",
      key: "company.email",
      message: "Email notifications are on but no company email is set as the sender.",
    });
  }

  return issues;
}

export function hasBlockingIssue(issues: readonly ConfigurationIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

export const validationService = {
  validate: validateConfiguration,
  hasBlockingIssue,
} as const;
