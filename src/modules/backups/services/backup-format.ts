/**
 * The backup file format.
 *
 * Pure — no database, no filesystem, no clock. It defines what a backup
 * contains, in what order, and what a restore is allowed to do to each table.
 * Kept separate from the services so it can be unit tested without a server
 * environment, the same split as `presence.ts` in M06.
 */

/**
 * Artifact format version.
 *
 * Bumped whenever the shape below changes. Import refuses a version it does not
 * understand rather than guessing: a restore driven by a misread file is worse
 * than a refused one.
 */
export const BACKUP_FORMAT_VERSION = 1;

/**
 * How a restore may touch a table.
 *
 * `reconcile` — create, update and delete, so the table ends up matching the
 * backup exactly.
 *
 * `append_only` — create missing rows only. Never update, never delete.
 * 01_MASTER_RULES.md: audit logs are immutable, never deleted, never modified.
 * A restore that reconciled them would delete every event recorded since the
 * backup was taken, which is precisely the history an incident needs.
 */
export type RestorePolicy = "reconcile" | "append_only";

export interface BackupTableSpec {
  readonly table: string;
  readonly policy: RestorePolicy;
}

/**
 * Tables captured, in dependency order.
 *
 * Order is load-bearing. Restore inserts in this order and deletes in reverse,
 * so a parent always exists before its children and is removed only after them.
 * Sorting this list alphabetically would break foreign keys.
 *
 * Excluded, deliberately:
 *
 *   auth.sessions   the M07 brief excludes sessions outright
 *   login_history   authentication telemetry tied to sessions rather than
 *                   business data; restoring it would resurrect sign-in events
 *                   for sessions that no longer exist
 *   backups         a backup that contained the backup catalogue would, on
 *                   restore, delete every backup taken since — including
 *                   itself
 */
export const BACKUP_TABLES: readonly BackupTableSpec[] = [
  { table: "users", policy: "reconcile" },
  { table: "customers", policy: "reconcile" },
  { table: "accounts", policy: "reconcile" },
  { table: "profiles", policy: "reconcile" },
  { table: "profile_events", policy: "append_only" },
  { table: "audit_logs", policy: "append_only" },
  { table: "settings", policy: "reconcile" },
];

export const BACKUP_TABLE_NAMES: readonly string[] = BACKUP_TABLES.map((spec) => spec.table);

/** Restore deletes children before parents. */
export const RESTORE_DELETE_ORDER: readonly string[] = [...BACKUP_TABLE_NAMES].reverse();

export function policyFor(table: string): RestorePolicy | null {
  return BACKUP_TABLES.find((spec) => spec.table === table)?.policy ?? null;
}

/**
 * Nullable columns that reference `users.id`.
 *
 * Needed because of the orphan rule: a user whose Supabase Auth identity no
 * longer exists cannot be restored, and any row pointing at that user would then
 * fail its foreign key. These columns are nulled instead, and every instance is
 * counted in the orphan report — silently dropping the referencing row would
 * lose an account or an audit entry to fix a user problem.
 */
export const NULLABLE_USER_REFERENCES: readonly { table: string; column: string }[] = [
  { table: "accounts", column: "created_by" },
  { table: "profiles", column: "worker_id" },
  { table: "profile_events", column: "user_id" },
  { table: "audit_logs", column: "user_id" },
  { table: "settings", column: "updated_by" },
];

/** Metadata written into the artifact, and checked on import. */
export interface BackupManifest {
  readonly formatVersion: number;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly appVersion: string;
  readonly databaseVersion: string;
  readonly type: string;
  readonly tables: readonly string[];
  readonly rowCounts: Readonly<Record<string, number>>;
}

export interface BackupArtifact {
  readonly manifest: BackupManifest;
  readonly data: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}

export type CompatibilityVerdict =
  | { readonly compatible: true; readonly warnings: readonly string[] }
  | { readonly compatible: false; readonly reason: string };

/**
 * Decides whether an artifact can be restored into this build.
 *
 * A newer format is refused outright — this code cannot know what changed. An
 * older one within the supported range is accepted with a warning, because
 * refusing to restore an old backup during an incident is the opposite of what
 * a backup system is for.
 *
 * Unknown tables are a warning rather than a refusal: a table dropped since the
 * backup was taken is a real scenario, and its data is simply skipped.
 */
export function checkCompatibility(manifest: BackupManifest): CompatibilityVerdict {
  if (!Number.isInteger(manifest.formatVersion) || manifest.formatVersion < 1) {
    return { compatible: false, reason: "The file does not declare a valid format version." };
  }

  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    return {
      compatible: false,
      reason:
        `This backup uses format version ${manifest.formatVersion}, but this ` +
        `version of the CRM understands at most ${BACKUP_FORMAT_VERSION}. Upgrade before restoring.`,
    };
  }

  const warnings: string[] = [];

  for (const table of manifest.tables) {
    if (!BACKUP_TABLE_NAMES.includes(table)) {
      warnings.push(`Table "${table}" is in the backup but no longer exists. It will be skipped.`);
    }
  }

  for (const table of BACKUP_TABLE_NAMES) {
    if (!manifest.tables.includes(table)) {
      warnings.push(`Table "${table}" is not in this backup. Its current rows are left untouched.`);
    }
  }

  return { compatible: true, warnings };
}
