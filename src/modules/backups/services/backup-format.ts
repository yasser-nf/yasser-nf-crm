/**
 * The backup file format.
 *
 * Pure — no database, no filesystem, no clock. It defines what a backup
 * contains, in what order, what a restore is allowed to do to each table, and
 * what a well-formed backup looks like. Kept separate from the services so it
 * can be unit tested without a server environment.
 */

/**
 * Artifact format version.
 *
 *   1  manifest + data + rowCounts. Integrity rested only on the checksum of
 *      the stored file, so a file edited and then imported passed.
 *   2  (M07) adds `contentSha256` — a hash of the DATA under a canonical
 *      serialisation — and `schemaVersion`. A v2 file proves its own content,
 *      independently of the catalogue row, the storage bucket or the UI.
 *
 * Import and restore refuse a version newer than this one. Version 1 is still
 * accepted — every backup taken before M07 is version 1, and refusing them
 * would leave the system with no restorable history — with a warning that its
 * content cannot be proven.
 */
export const BACKUP_FORMAT_VERSION = 2;
export const OLDEST_SUPPORTED_FORMAT_VERSION = 1;

/**
 * How a restore may touch a table.
 *
 * `reconcile` — create, update and delete, so the table ends up matching the
 * backup exactly.
 *
 * `append_only` — create missing rows only; never update, never delete what a
 * restore did not bring. History tables: 01_MASTER_RULES.md makes audit logs
 * immutable, and a restore that reconciled them would erase every event since
 * the backup — including the record of the restore itself. (The DATABASE can
 * still remove such a row by cascade when its parent goes; the restore
 * rehearsal reports every one of those before anything is confirmed.)
 */
export type RestorePolicy = "reconcile" | "append_only";

export interface BackupTableSpec {
  readonly table: string;
  readonly policy: RestorePolicy;
}

/**
 * Tables captured, in dependency order. Order is load-bearing: restore inserts
 * in this order and deletes in reverse, so a parent always exists before its
 * children and is removed only after them.
 *
 * Every business table in the schema is here (M07 added the last four: before
 * M07, problems, their notes, notifications and report presets were not backed
 * up at all). A test compares this list with the database catalogue, so a
 * table added later without a decision here fails the suite.
 *
 * Excluded, deliberately:
 *
 *   auth.*          Supabase Auth — identities and credentials belong to the
 *                   auth service, not to this backup (see the orphan rule)
 *   login_history   authentication telemetry tied to sessions
 *   backups         the catalogue: restoring it would delete every backup
 *                   taken since, including the safety snapshot of this restore
 */
export const BACKUP_TABLES: readonly BackupTableSpec[] = [
  { table: "users", policy: "reconcile" },
  { table: "customers", policy: "reconcile" },
  { table: "accounts", policy: "reconcile" },
  { table: "profiles", policy: "reconcile" },
  { table: "profile_events", policy: "append_only" },
  { table: "issues", policy: "reconcile" },
  { table: "issue_notes", policy: "append_only" },
  { table: "notifications", policy: "reconcile" },
  { table: "report_presets", policy: "reconcile" },
  { table: "audit_logs", policy: "append_only" },
  { table: "settings", policy: "reconcile" },
];

export const BACKUP_TABLE_NAMES: readonly string[] = BACKUP_TABLES.map((spec) => spec.table);

/** Public tables that are deliberately NOT backed up. */
export const EXCLUDED_TABLES: readonly string[] = ["backups", "login_history"];

/**
 * What a person must type to confirm a restore. Here, in the pure module, so
 * the restore panel (a Client Component) can show it without importing the
 * server-only restore service.
 */
export const RESTORE_CONFIRMATION = "RESTORE";

/** Restore deletes children before parents. */
export const RESTORE_DELETE_ORDER: readonly string[] = [...BACKUP_TABLE_NAMES].reverse();

export function policyFor(table: string): RestorePolicy | null {
  return BACKUP_TABLES.find((spec) => spec.table === table)?.policy ?? null;
}

/**
 * Every foreign key between backed-up tables, as the schema declares it.
 *
 * Used to prove a backup is internally consistent BEFORE a restore writes
 * anything: a child pointing at a parent row the backup does not contain means
 * the file is corrupt or was edited. A test checks this list against
 * pg_constraint, so it cannot drift from the real schema silently.
 */
export interface Relationship {
  readonly table: string;
  readonly column: string;
  readonly parent: string;
  readonly nullable: boolean;
}

export const RELATIONSHIPS: readonly Relationship[] = [
  { table: "accounts", column: "created_by", parent: "users", nullable: true },
  { table: "profiles", column: "account_id", parent: "accounts", nullable: false },
  { table: "profiles", column: "customer_id", parent: "customers", nullable: true },
  { table: "profiles", column: "worker_id", parent: "users", nullable: true },
  { table: "profile_events", column: "account_id", parent: "accounts", nullable: false },
  { table: "profile_events", column: "profile_id", parent: "profiles", nullable: false },
  { table: "profile_events", column: "customer_id", parent: "customers", nullable: true },
  { table: "profile_events", column: "user_id", parent: "users", nullable: true },
  { table: "issues", column: "account_id", parent: "accounts", nullable: false },
  { table: "issues", column: "assigned_to", parent: "users", nullable: true },
  { table: "issues", column: "reported_by", parent: "users", nullable: true },
  { table: "issues", column: "resolved_by", parent: "users", nullable: true },
  { table: "issue_notes", column: "issue_id", parent: "issues", nullable: false },
  { table: "issue_notes", column: "user_id", parent: "users", nullable: true },
  { table: "notifications", column: "recipient_id", parent: "users", nullable: false },
  { table: "notifications", column: "actor_id", parent: "users", nullable: true },
  { table: "report_presets", column: "user_id", parent: "users", nullable: false },
  { table: "audit_logs", column: "user_id", parent: "users", nullable: true },
  { table: "settings", column: "updated_by", parent: "users", nullable: true },
];

/**
 * The orphan rule's two halves. `public.users.id` references `auth.users(id)`;
 * a backed-up user whose Auth identity no longer exists cannot be inserted.
 * References to such a user are NULLED where the column allows it, and the
 * referencing row is SKIPPED where it does not (a notification cannot exist
 * without its recipient). Every instance is counted and reported.
 */
export const NULLABLE_USER_REFERENCES: readonly { table: string; column: string }[] =
  RELATIONSHIPS.filter((rel) => rel.parent === "users" && rel.nullable).map(
    ({ table, column }) => ({ table, column }),
  );

export const REQUIRED_USER_REFERENCES: readonly { table: string; column: string }[] =
  RELATIONSHIPS.filter((rel) => rel.parent === "users" && !rel.nullable).map(
    ({ table, column }) => ({ table, column }),
  );

/** Metadata written into the artifact, and checked on import and restore. */
export interface BackupManifest {
  readonly formatVersion: number;
  /** Number of migrations applied when it was taken. Absent before v2. */
  readonly schemaVersion?: number | undefined;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly appVersion: string;
  readonly databaseVersion: string;
  readonly type: string;
  readonly tables: readonly string[];
  readonly rowCounts: Readonly<Record<string, number>>;
  /** SHA-256 of the data under `canonicalJson`. Required from v2. */
  readonly contentSha256?: string | undefined;
}

export type BackupData = Readonly<Record<string, readonly Record<string, unknown>[]>>;

export interface BackupArtifact {
  readonly manifest: BackupManifest;
  readonly data: BackupData;
}

export type CompatibilityVerdict =
  | { readonly compatible: true; readonly warnings: readonly string[] }
  | { readonly compatible: false; readonly reason: string };

/**
 * Decides whether an artifact can be restored into this build.
 *
 * Newer format or newer schema: refused — this code cannot know what changed.
 * Older: accepted with warnings, because refusing an old backup during an
 * incident is the opposite of what a backup system is for; anything an older
 * shape cannot satisfy is then caught by validation and the rehearsal.
 */
export function checkCompatibility(
  manifest: BackupManifest,
  currentSchemaVersion?: number,
): CompatibilityVerdict {
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

  if (manifest.formatVersion >= 2 && !manifest.contentSha256) {
    return {
      compatible: false,
      reason: "This backup declares format version 2 but carries no content hash.",
    };
  }

  if (
    manifest.schemaVersion !== undefined &&
    currentSchemaVersion !== undefined &&
    manifest.schemaVersion > currentSchemaVersion
  ) {
    return {
      compatible: false,
      reason:
        `This backup was taken on a newer database schema (${manifest.schemaVersion} ` +
        `migrations) than this one (${currentSchemaVersion}). Upgrade before restoring.`,
    };
  }

  const warnings: string[] = [];

  if (manifest.formatVersion < 2) {
    warnings.push(
      "This is a version 1 backup: it carries no content hash, so its integrity rests on the " +
        "stored file's checksum alone.",
    );
  }

  if (
    manifest.schemaVersion !== undefined &&
    currentSchemaVersion !== undefined &&
    manifest.schemaVersion < currentSchemaVersion
  ) {
    warnings.push(
      `This backup was taken on an older schema (${manifest.schemaVersion} migrations; ` +
        `now ${currentSchemaVersion}). Columns added since take their defaults.`,
    );
  }

  for (const table of manifest.tables) {
    if (!BACKUP_TABLE_NAMES.includes(table)) {
      warnings.push(`Table "${table}" is in the backup but no longer exists. It will be skipped.`);
    }
  }

  for (const table of BACKUP_TABLE_NAMES) {
    if (!manifest.tables.includes(table)) {
      warnings.push(
        `Table "${table}" is not in this backup. Its rows are not restored; the rehearsal ` +
          `shows any that the database removes along with a restored parent.`,
      );
    }
  }

  return { compatible: true, warnings };
}

/* ------------------------------------------------------------------------- */
/* Canonical serialisation                                                    */
/* ------------------------------------------------------------------------- */

/**
 * JSON with object keys sorted at every depth.
 *
 * The content hash must not depend on the order in which PostgreSQL, the
 * driver or JavaScript happened to lay out a row's keys — only on its values.
 * Arrays keep their order (it is meaningful); objects do not.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();

    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

/**
 * The exact byte sequence the content hash covers, one line per unit:
 *
 *   table:<name>          before each table, in manifest order
 *   <canonical row>       each row, in file order
 *
 * Written out so anyone can re-derive a hash with any SHA-256 tool.
 */
export function contentLines(
  tables: readonly string[],
  data: BackupData,
): Generator<string, void, undefined> {
  return (function* () {
    for (const table of tables) {
      yield `table:${table}\n`;

      for (const row of data[table] ?? []) {
        yield `${canonicalJson(row)}\n`;
      }
    }
  })();
}

/* ------------------------------------------------------------------------- */
/* Structural validation — before any write                                   */
/* ------------------------------------------------------------------------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Problems past this many are summarised: the first ones tell the story. */
const MAX_PROBLEMS = 25;

/**
 * Everything that can be proven wrong about a backup from the file alone.
 * An empty list means structurally sound; anything else refuses the restore.
 *
 *   - tables and manifest agree, and row counts match
 *   - every row is an object with a uuid `id`, unique within its table
 *   - every relationship between two backed-up tables resolves inside the
 *     backup (a restore replaces those tables wholesale, so a reference to a
 *     row the backup does not contain can only be corruption)
 */
export function validateBackupStructure(manifest: BackupManifest, data: BackupData): string[] {
  const problems: string[] = [];
  const report = (problem: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(problem);
  };

  const declared = new Set(manifest.tables);

  for (const table of manifest.tables) {
    if (!(table in data)) {
      report(`Table "${table}" is listed in the manifest but has no data.`);
    }
  }

  for (const table of Object.keys(data)) {
    if (!declared.has(table)) {
      report(`Table "${table}" has data but is not listed in the manifest.`);
    }
  }

  const idsByTable = new Map<string, Set<string>>();

  for (const table of manifest.tables) {
    const rows = data[table] ?? [];
    const expected = manifest.rowCounts[table];

    if (expected !== undefined && expected !== rows.length) {
      report(`Table "${table}" declares ${expected} rows but contains ${rows.length}.`);
    }

    const ids = new Set<string>();

    rows.forEach((row, index) => {
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        report(`Table "${table}", row ${index + 1}: not an object.`);
        return;
      }

      const id = row["id"];

      if (typeof id !== "string" || !UUID.test(id)) {
        report(`Table "${table}", row ${index + 1}: missing or invalid id.`);
        return;
      }

      if (ids.has(id)) {
        report(`Table "${table}": duplicate id ${id}.`);
      }

      ids.add(id);
    });

    idsByTable.set(table, ids);
  }

  for (const rel of RELATIONSHIPS) {
    const children = data[rel.table];
    const parents = idsByTable.get(rel.parent);

    /* Only checkable when both sides are in this backup. */
    if (!children || !parents || !declared.has(rel.table) || !declared.has(rel.parent)) {
      continue;
    }

    for (const row of children) {
      const value = row?.[rel.column];

      if (value === null || value === undefined) {
        if (!rel.nullable) {
          report(`Table "${rel.table}": ${rel.column} is required but empty.`);
        }
        continue;
      }

      if (typeof value !== "string" || !parents.has(value)) {
        report(
          `Table "${rel.table}": ${rel.column} refers to a ${rel.parent} row the backup does not contain.`,
        );
      }
    }
  }

  return problems;
}

/** Column facts the catalogue validation needs, per table. */
export interface ColumnFacts {
  readonly name: string;
  /** NOT NULL with no default: a row that omits it cannot be inserted. */
  readonly required: boolean;
  /** Allowed labels for an enum column; null for any other type. */
  readonly enumLabels: readonly string[] | null;
}

/**
 * What can be proven wrong about a backup against the CURRENT schema, before
 * any write: required columns missing, and enum values the database would
 * refuse. Unknown columns are not a problem — they are dropped, and returned
 * separately as warnings (a column removed since the backup is an ordinary
 * migration).
 */
export function validateAgainstSchema(
  data: BackupData,
  columns: ReadonlyMap<string, readonly ColumnFacts[]>,
): { readonly problems: string[]; readonly warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];

  for (const [table, rows] of Object.entries(data)) {
    const facts = columns.get(table);

    if (!facts || rows.length === 0) {
      continue;
    }

    const known = new Set(facts.map((fact) => fact.name));
    const unknown = new Set<string>();

    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!known.has(key)) unknown.add(key);
      }
    }

    if (unknown.size > 0) {
      warnings.push(
        `Table "${table}": column(s) ${[...unknown].sort().join(", ")} no longer exist and will be ignored.`,
      );
    }

    for (const fact of facts) {
      if (
        fact.required &&
        rows.some((row) => row[fact.name] === null || row[fact.name] === undefined)
      ) {
        problems.push(`Table "${table}": required column ${fact.name} is missing in some rows.`);
      }

      if (fact.enumLabels) {
        const invalid = rows.find((row) => {
          const value = row[fact.name];
          return value !== null && value !== undefined && !fact.enumLabels?.includes(String(value));
        });

        if (invalid) {
          problems.push(`Table "${table}": ${fact.name} holds a value this schema does not allow.`);
        }
      }
    }

    if (problems.length >= MAX_PROBLEMS) {
      break;
    }
  }

  return { problems, warnings };
}
