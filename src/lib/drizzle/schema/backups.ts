import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { backupStatusEnum, backupTypeEnum } from "./enums";
import { users } from "./users";

/**
 * Backup metadata.
 *
 * Tracks backup operations. Does not store the backup itself — that belongs in
 * object storage, with this row pointing at it.
 *
 * 01_MASTER_RULES.md requires backups to be verifiable and restorable, which is
 * why `checksum` and the separate `verified` status exist: a backup that has
 * completed is not yet known to be restorable, and treating the two as the same
 * thing is how organisations discover their backups are empty during a restore.
 *
 * M02 creates the table only. The Backup Engine is a later milestone.
 */
export const backups = pgTable(
  "backups",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Human-readable label, shown in the list. Generated from type and time
     * rather than typed by a person: a backup nobody named is still a backup
     * somebody has to recognise during an incident.
     */
    name: text("name").notNull(),

    type: backupTypeEnum("type").notNull(),
    status: backupStatusEnum("status").notNull().default("pending"),

    /** Storage object name. Null until the write completes. */
    filename: text("filename"),

    /** bigint: a database dump can exceed the 2GB integer ceiling. */
    sizeBytes: bigint("size_bytes", { mode: "number" }),

    /** Content hash, for the verification step. */
    checksum: text("checksum"),

    /**
     * Marks a deliberate restore point, as distinct from a routine scheduled
     * backup. 01_MASTER_RULES.md lists restore points as their own concept.
     */
    isRestorePoint: boolean("is_restore_point").notNull().default(false),

    /**
     * Backup file format version.
     *
     * Bumped when the artifact's shape changes. Import refuses a version it does
     * not understand rather than guessing — a restore driven by a
     * misinterpreted file is worse than a refused one.
     */
    formatVersion: integer("format_version").notNull().default(1),

    /** Versions of the system that produced it, for compatibility reporting. */
    appVersion: text("app_version"),
    databaseVersion: text("database_version"),

    /**
     * Tables captured, with their row counts: `{ "accounts": 120, ... }`.
     *
     * Stored rather than derived because the whole point is to answer "what is
     * in this backup" without downloading and decompressing it. It is also the
     * only surviving record of scale once a backup is pruned.
     */
    tableCounts: jsonb("table_counts").notNull().default({}),

    /** Null for scheduled backups, which no person triggers. */
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),

    errorMessage: text("error_message"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => [
    index("backups_type_idx").on(table.type),
    index("backups_status_idx").on(table.status),
    index("backups_created_at_idx").on(table.createdAt.desc()),

    /* Restore points are the set a human browses when recovering. */
    index("backups_restore_point_idx")
      .on(table.createdAt.desc())
      .where(sql`${table.isRestorePoint} = true`),

    /*
     * A finished backup must be describable. Without this, a failed job can leave
     * a `completed` row with no file and no checksum, which reads as a healthy
     * backup and is worse than a visible failure.
     */
    check(
      "backups_completed_has_artifact",
      sql`${table.status} not in ('completed', 'verified')
          or (${table.filename} is not null and ${table.checksum} is not null and ${table.completedAt} is not null)`,
    ),

    check(
      "backups_failed_has_reason",
      sql`${table.status} <> 'failed' or ${table.errorMessage} is not null`,
    ),

    check(
      "backups_verified_has_timestamp",
      sql`${table.status} <> 'verified' or ${table.verifiedAt} is not null`,
    ),
  ],
);

export type BackupRow = typeof backups.$inferSelect;
export type NewBackupRow = typeof backups.$inferInsert;
