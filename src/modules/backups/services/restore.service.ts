import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { databaseAdapter, type DatabaseTransaction } from "@/lib/database";
import {
  ConflictError,
  ForbiddenError,
  ValidationError,
  describeCause,
  isAppError,
} from "@/lib/errors";
import { auditService, type AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { backupsRepository } from "../repositories/backups.repository";
import {
  datasetRepository,
  deleteRows,
  idsOf,
  lockBackedUpTables,
  nullableReferenceCounts,
  publicTableCounts,
  tryRestoreLock,
  upsertRows,
  type DatasetRow,
} from "../repositories/dataset.repository";
import { backupStorage } from "../storage/backup-storage";
import { backupArtifactSchema } from "../validation/backup.schema";
import { readArtifact } from "./artifact-writer";
import {
  BACKUP_TABLES,
  NULLABLE_USER_REFERENCES,
  REQUIRED_USER_REFERENCES,
  RESTORE_CONFIRMATION,
  RESTORE_DELETE_ORDER,
  checkCompatibility,
  policyFor,
  validateAgainstSchema,
  validateBackupStructure,
  type BackupManifest,
} from "./backup-format";
import { backupEngine } from "./backup.service";
import { backupMacKey } from "./backup-key";
import { checksumService } from "./checksum.service";

/**
 * Restore service — the most dangerous operation in the CRM.
 *
 *   Backup
 *     ↓ download                       the stored file
 *     ↓ file checksum                  refused if the bytes changed
 *     ↓ parse + compatibility          refused if newer format or schema
 *     ↓ content hash (format 2)        refused if the data was altered
 *     ↓ structure                      ids, duplicates, counts, every relationship
 *     ↓ schema                         required columns, enum values
 *   PREVIEW
 *     ↓ REHEARSAL                      the whole restore, run in a transaction
 *                                      that is always rolled back: every
 *                                      constraint checked by the database itself,
 *                                      and the exact effect on every table —
 *                                      cascades included — measured
 *   Human reads it, types RESTORE
 *   RESTORE
 *     ↓ same validation again          on the same file (its checksum must match
 *                                      the one previewed)
 *     ↓ target marked restore point    retention can never delete it
 *     ↓ safety snapshot                the way back; no snapshot, no restore
 *     ↓ ONE transaction, restore lock  deletes children-first, upserts
 *                                      parents-first; commit, or nothing
 *
 * Nothing destructive happens until every check has passed, and the apply is
 * atomic by construction: the adapter's transaction rolls back on any throw.
 *
 * EVIDENCE. `restore_started` is audited before the apply and
 * `restored`/`restore_failed` after it. audit_logs is append-only in a restore
 * — rows not in the backup are kept — so the record that a restore happened is
 * never erased by the restore.
 */

export interface TableChange {
  readonly table: string;
  readonly policy: "reconcile" | "append_only";
  readonly create: number;
  readonly update: number;
  readonly delete: number;
}

export interface OrphanUser {
  readonly id: string;
  readonly email: string;
  readonly reason: string;
}

/** The measured effect of a restore: every public table, before and after. */
export interface RestoreEffects {
  readonly tables: readonly { table: string; before: number; after: number }[];
  /** Links cleared by ON DELETE SET NULL, per reference, e.g. "audit_logs.user_id". */
  readonly linksCleared: readonly { reference: string; count: number }[];
}

export interface RestorePreview {
  readonly backupId: string;
  /** The file checksum the preview was computed from; the restore must match it. */
  readonly checksum: string;
  readonly formatVersion: number;
  readonly checksumVerified: boolean;
  /** Version 2 files: the data was proven against its own content hash. */
  readonly contentVerified: boolean;
  /** The rehearsal ran and was rolled back: the database accepted every row. */
  readonly rehearsed: boolean;
  readonly changes: readonly TableChange[];
  readonly totals: { create: number; update: number; delete: number };
  readonly effects: RestoreEffects;
  readonly warnings: readonly string[];
  readonly conflicts: readonly string[];
  readonly orphans: readonly OrphanUser[];
}

export interface RestoreOutcome {
  readonly backupId: string;
  readonly applied: readonly TableChange[];
  readonly orphans: readonly OrphanUser[];
  readonly nulledReferences: number;
  readonly skippedRows: number;
  readonly effects: RestoreEffects;
  readonly safetySnapshotId: string | null;
}

export { RESTORE_CONFIRMATION };

export const restoreRequestSchema = z.object({
  confirmation: z.literal(RESTORE_CONFIRMATION),
  /** The checksum shown in the preview: the restore applies that file or nothing. */
  expectedChecksum: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * Drill-only options (M12 P0-4). `schema` redirects the apply at a disposable
 * schema, exactly as `scripts/rollback-drill.mjs` does for migrations. Omitted —
 * every production and application call — nothing changes. A drill also skips
 * the safety snapshot: it is not touching the live data.
 */
export interface RestoreOptions {
  readonly schema?: string;
}

const SAFE_SCHEMA = /^[a-z_][a-z0-9_]*$/;

function requireBackupAccess(actor: AppUser | null, action: string): Result<AppUser> {
  if (!actor) {
    return fail(new ForbiddenError(`No signed-in user for ${action}`));
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.ACCESS_BACKUPS)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not ${action}`, {
        userMessage: "Restoring is restricted to Super Admins.",
      }),
    );
  }

  return ok(actor);
}

interface LoadedArtifact {
  readonly manifest: BackupManifest;
  readonly data: Record<string, DatasetRow[]>;
  readonly warnings: readonly string[];
  readonly checksum: string;
  readonly contentVerified: boolean;
}

function refuse(message: string, userMessage: string): Result<never> {
  return fail(new ValidationError(message, { userMessage }));
}

/**
 * Fetches a stored backup and proves it, before anything else is done with it.
 * The single place both preview and restore obtain their data, so neither can
 * skip a check.
 */
async function load(backupId: string): Promise<Result<LoadedArtifact>> {
  const backup = await backupsRepository.findById(backupId);

  if (!backup.ok) {
    return backup;
  }

  if (
    !backup.value.filename ||
    !backup.value.checksum ||
    (backup.value.status !== "completed" && backup.value.status !== "verified")
  ) {
    return refuse(
      "Backup is not a finished backup",
      "This backup did not complete, so it cannot be restored.",
    );
  }

  const body = await backupStorage.download(backup.value.filename);

  if (!body.ok) {
    return body;
  }

  if (!checksumService.matches(backup.value.checksum, checksumService.of(body.value))) {
    return refuse(
      `Checksum mismatch on backup ${backupId}`,
      "This backup is corrupted — its checksum does not match. Restore refused.",
    );
  }

  let document: unknown;

  try {
    document = readArtifact(body.value);
  } catch {
    return refuse("Backup could not be decompressed", "This backup could not be read.");
  }

  const parsed = backupArtifactSchema.safeParse(document);

  if (!parsed.success) {
    return refuse(
      "Backup failed schema validation",
      "This backup's structure is not valid. Restore refused.",
    );
  }

  const { manifest } = parsed.data;
  const data = parsed.data.data as Record<string, DatasetRow[]>;

  const schemaVersion = await datasetRepository.schemaVersion();
  const compatibility = checkCompatibility(
    manifest,
    schemaVersion.ok && schemaVersion.value !== null ? schemaVersion.value : undefined,
  );

  if (!compatibility.compatible) {
    return refuse(compatibility.reason, compatibility.reason);
  }

  if (
    manifest.contentMac &&
    !checksumService.matches(
      manifest.contentMac,
      checksumService.manifestMac(manifest, backupMacKey()),
    )
  ) {
    return refuse(
      "Backup signature mismatch",
      "This backup's signature does not match — it was altered, or made by another installation. Restore refused.",
    );
  }

  let contentVerified = false;

  if (manifest.contentSha256) {
    const actual = checksumService.contentSha256(manifest.tables, data);

    if (!checksumService.matches(manifest.contentSha256, actual)) {
      return refuse(
        "Content hash mismatch",
        "This backup's data does not match its own content hash — it was altered or damaged. Restore refused.",
      );
    }

    contentVerified = true;
  }

  const structural = validateBackupStructure(manifest, data);

  if (structural.length > 0) {
    return refuse(
      `Backup is internally inconsistent: ${structural.join(" | ")}`,
      `This backup is not consistent and was refused before anything changed: ${structural[0]}`,
    );
  }

  const facts = await datasetRepository.columnFacts();

  if (!facts.ok) {
    return facts;
  }

  const schemaCheck = validateAgainstSchema(data, facts.value);

  if (schemaCheck.problems.length > 0) {
    return refuse(
      `Backup does not fit the current schema: ${schemaCheck.problems.join(" | ")}`,
      `This backup does not fit the current database and was refused before anything changed: ${schemaCheck.problems[0]}`,
    );
  }

  return ok({
    manifest,
    data,
    warnings: [...compatibility.warnings, ...schemaCheck.warnings],
    checksum: backup.value.checksum,
    contentVerified,
  });
}

function rowId(row: DatasetRow): string | null {
  const id = row["id"];
  return typeof id === "string" ? id : null;
}

/**
 * Users that cannot be restored: `public.users.id` references `auth.users(id)`,
 * and a backed-up user whose Auth identity has since been deleted cannot be
 * inserted. Skip, report, restore everything else (ADR-009 Decision 4).
 */
async function findOrphans(users: readonly DatasetRow[]): Promise<Result<OrphanUser[]>> {
  const ids = users.map(rowId).filter((id): id is string => id !== null);
  const existing = await datasetRepository.existingAuthUserIds(ids);

  if (!existing.ok) {
    return existing;
  }

  return ok(
    users.flatMap((row) => {
      const id = rowId(row);

      return id && !existing.value.has(id)
        ? [
            {
              id,
              email: typeof row["email"] === "string" ? row["email"] : "(unknown)",
              reason: "No Supabase Auth identity exists for this user any more.",
            },
          ]
        : [];
    }),
  );
}

async function measure(executor: DatabaseTransaction) {
  const [tables, links] = [
    await publicTableCounts(executor),
    await nullableReferenceCounts(executor),
  ];
  return { tables, links };
}

function effectsBetween(
  before: Awaited<ReturnType<typeof measure>>,
  after: Awaited<ReturnType<typeof measure>>,
): RestoreEffects {
  return {
    tables: Object.keys(before.tables)
      .filter((table) => table !== "backups")
      .map((table) => ({
        table,
        before: before.tables[table] ?? 0,
        after: after.tables[table] ?? 0,
      })),
    linksCleared: Object.keys(before.links)
      .map((reference) => ({
        reference,
        count: Math.max((before.links[reference] ?? 0) - (after.links[reference] ?? 0), 0),
      }))
      .filter((entry) => entry.count > 0 && !entry.reference.startsWith("backups.")),
  };
}

interface Applied {
  readonly applied: TableChange[];
  readonly nulledReferences: number;
  readonly skippedRows: number;
}

/**
 * The restore itself, inside a caller's transaction — the rehearsal's (rolled
 * back) or the real one (committed). One function, so what was rehearsed is
 * exactly what is applied.
 *
 * Only tables CONTAINED in the backup are touched. A table an older backup
 * does not carry is left alone (before M07 it was treated as "keep no rows" and
 * emptied); the database may still remove some of its rows by cascade, and the
 * rehearsal measures exactly how many.
 */
async function apply(
  executor: DatabaseTransaction,
  loaded: LoadedArtifact,
  orphanIds: ReadonlySet<string>,
): Promise<Applied> {
  const included = new Set(loaded.manifest.tables);
  const users = (loaded.data["users"] ?? []).filter((row) => {
    const id = rowId(row);
    return id !== null && !orphanIds.has(id);
  });

  /*
   * After this transaction, `users` holds exactly the restorable backup users —
   * reconcile deletes everyone else — so those are the only ids a reference may
   * point at.
   */
  const validUserIds = new Set(users.map((row) => rowId(row) ?? ""));
  const applied: TableChange[] = [];
  let nulledReferences = 0;
  let skippedRows = 0;

  for (const table of RESTORE_DELETE_ORDER) {
    if (policyFor(table) !== "reconcile" || !included.has(table)) {
      continue;
    }

    const keep = new Set(
      (table === "users" ? users : (loaded.data[table] ?? []))
        .map(rowId)
        .filter((id): id is string => id !== null),
    );
    const present = await idsOf(executor, table);
    const removed = await deleteRows(
      executor,
      table,
      [...present].filter((id) => !keep.has(id)),
    );

    applied.push({ table, policy: "reconcile", create: 0, update: 0, delete: removed });
  }

  for (const spec of BACKUP_TABLES) {
    if (!included.has(spec.table)) {
      continue;
    }

    const source = spec.table === "users" ? users : (loaded.data[spec.table] ?? []);
    const nullable = NULLABLE_USER_REFERENCES.filter((ref) => ref.table === spec.table);
    const required = REQUIRED_USER_REFERENCES.filter((ref) => ref.table === spec.table);

    const rows = source.flatMap((row) => {
      /* A row that cannot exist without an unrestorable user is skipped and counted. */
      if (
        required.some(
          (ref) =>
            typeof row[ref.column] === "string" && !validUserIds.has(row[ref.column] as string),
        )
      ) {
        skippedRows += 1;
        return [];
      }

      if (nullable.length === 0) {
        return [row];
      }

      const copy: DatasetRow = { ...row };

      for (const ref of nullable) {
        const value = copy[ref.column];

        if (typeof value === "string" && !validUserIds.has(value)) {
          copy[ref.column] = null;
          nulledReferences += 1;
        }
      }

      return [copy];
    });

    const written = await upsertRows(executor, spec.table, rows, spec.policy);

    applied.push({ table: spec.table, policy: spec.policy, create: written, update: 0, delete: 0 });
  }

  return { applied, nulledReferences, skippedRows };
}

/** The database's own words for why a rehearsal or restore failed, without values. */
function databaseReason(error: unknown): string {
  const described = isAppError(error) ? describeCause(error.cause) : describeCause(error);
  const last = described.split(" ← ").at(-1) ?? described;

  return last.replace(/^PostgresError/, "Database").slice(0, 240) || "The database refused it.";
}

/** Preview: what a restore would do, proven by rehearsing it — and doing none of it. */
async function preview(backupId: string, actor: AppUser | null): Promise<Result<RestorePreview>> {
  const permitted = requireBackupAccess(actor, "preview a restore");

  if (!permitted.ok) {
    return permitted;
  }

  const loaded = await load(backupId);

  if (!loaded.ok) {
    return loaded;
  }

  const orphans = await findOrphans(loaded.value.data["users"] ?? []);

  if (!orphans.ok) {
    return orphans;
  }

  const orphanIds = new Set(orphans.value.map((entry) => entry.id));
  const warnings = [...loaded.value.warnings];
  const conflicts: string[] = [];
  const changes: TableChange[] = [];

  for (const spec of BACKUP_TABLES) {
    if (!loaded.value.manifest.tables.includes(spec.table)) {
      continue;
    }

    const rows = loaded.value.data[spec.table] ?? [];
    const current = await datasetRepository.readAll(spec.table);

    if (!current.ok) {
      return current;
    }

    const currentById = new Map(current.value.map((row) => [rowId(row) ?? "", row] as const));
    const backupIds = new Set(rows.map(rowId).filter((id): id is string => id !== null));

    let create = 0;
    let update = 0;

    for (const row of rows) {
      const id = rowId(row);

      if (!id || (spec.table === "users" && orphanIds.has(id))) {
        continue;
      }

      const existing = currentById.get(id);

      if (!existing) {
        create += 1;
      } else if (spec.policy === "reconcile" && JSON.stringify(existing) !== JSON.stringify(row)) {
        update += 1;
        conflicts.push(`${spec.table}: row ${id} differs from the backup and will be overwritten.`);
      }
    }

    const extra = current.value.filter((row) => {
      const id = rowId(row);
      return id !== null && !backupIds.has(id);
    }).length;

    if (spec.policy === "append_only" && extra > 0) {
      warnings.push(
        `${spec.table}: ${extra} row(s) recorded since this backup are kept — this table is ` +
          `append-only (except rows the database removes with a deleted parent; see the effects).`,
      );
    }

    changes.push({
      table: spec.table,
      policy: spec.policy,
      create,
      update,
      delete: spec.policy === "reconcile" ? extra : 0,
    });
  }

  for (const orphan of orphans.value) {
    warnings.push(`User ${orphan.email} cannot be restored: ${orphan.reason}`);
  }

  /* The rehearsal: the real restore, in a transaction that is always rolled back. */
  const rehearsal = await databaseAdapter.rehearse("restore.rehearse", async (executor) => {
    const before = await measure(executor);
    const result = await apply(executor, loaded.value, orphanIds);
    const after = await measure(executor);

    return { result, effects: effectsBetween(before, after) };
  });

  if (!rehearsal.ok) {
    return fail(
      new ValidationError("Restore rehearsal was refused by the database", {
        cause: rehearsal.error,
        userMessage:
          `The restore was rehearsed and the database refused it (${databaseReason(rehearsal.error)}). ` +
          "Nothing was changed.",
      }),
    );
  }

  if (rehearsal.value.result.skippedRows > 0) {
    warnings.push(
      `${rehearsal.value.result.skippedRows} row(s) belong to a user who cannot be restored and will be skipped.`,
    );
  }

  const totals = changes.reduce(
    (sum, change) => ({
      create: sum.create + change.create,
      update: sum.update + change.update,
      delete: sum.delete + change.delete,
    }),
    { create: 0, update: 0, delete: 0 },
  );

  return ok({
    backupId,
    checksum: loaded.value.checksum,
    formatVersion: loaded.value.manifest.formatVersion,
    checksumVerified: true,
    contentVerified: loaded.value.contentVerified,
    rehearsed: true,
    changes,
    totals,
    effects: rehearsal.value.effects,
    warnings,
    /* Capped: a list of ten thousand ids helps nobody decide. */
    conflicts: conflicts.slice(0, 50),
    orphans: orphans.value,
  });
}

async function auditRestore(
  backupId: string,
  after: Record<string, unknown>,
  context: AuditContext,
): Promise<void> {
  await auditService.recordOrWarn(
    { entity: "backup", entityId: backupId, action: "restore", after },
    context,
  );
}

/** Applies a restore. All of it, or none of it — and only what was previewed. */
async function restore(
  backupId: string,
  input: unknown,
  context: AuditContext,
  options?: RestoreOptions,
): Promise<Result<RestoreOutcome>> {
  const permitted = requireBackupAccess(context.actor, "restore a backup");

  if (!permitted.ok) {
    return permitted;
  }

  const request = restoreRequestSchema.safeParse(input);

  if (!request.success) {
    return refuse(
      "Restore was not confirmed",
      `Type ${RESTORE_CONFIRMATION} to confirm, after reviewing the preview.`,
    );
  }

  if (options?.schema !== undefined && !SAFE_SCHEMA.test(options.schema)) {
    return refuse(
      "Refusing to restore into an unsafe schema name",
      "That restore target is not a valid schema.",
    );
  }

  const loaded = await load(backupId);

  if (!loaded.ok) {
    await auditRestore(backupId, { event: "restore_failed", reason: loaded.error.code }, context);
    return loaded;
  }

  if (!checksumService.matches(request.data.expectedChecksum, loaded.value.checksum)) {
    return fail(
      new ConflictError("Backup changed since it was previewed", {
        userMessage: "This backup is not the one you previewed. Preview it again before restoring.",
      }),
    );
  }

  const orphans = await findOrphans(loaded.value.data["users"] ?? []);

  if (!orphans.ok) {
    return orphans;
  }

  const orphanIds = new Set(orphans.value.map((entry) => entry.id));

  /*
   * Restored-from backups are kept for good: retention can never delete them
   * (it re-checks this flag at delete time). If the row has just been pruned,
   * the restore stops here — before any write — rather than proceed from a
   * backup that no longer exists.
   */
  const marked = await backupsRepository.markRestorePoint(backupId);

  if (!marked.ok) {
    return refuse(
      "Backup disappeared before the restore could protect it",
      "This backup no longer exists. Nothing was restored.",
    );
  }

  await auditRestore(backupId, { event: "restore_started" }, context);

  /* The way back. No snapshot, no restore. */
  let safetySnapshotId: string | null = null;

  if (options?.schema === undefined) {
    const snapshot = await backupEngine.runBackup("snapshot", context, { prune: false });

    if (!snapshot.ok) {
      await auditRestore(
        backupId,
        { event: "restore_failed", reason: "safety_snapshot_failed" },
        context,
      );

      return fail(
        new ValidationError("Safety snapshot failed; restore not attempted", {
          cause: snapshot.error,
          userMessage:
            "A snapshot of the current data could not be taken first, so nothing was restored.",
        }),
      );
    }

    safetySnapshotId = snapshot.value.id;
  }

  const outcome = await databaseAdapter.transaction("restore.apply", async (executor) => {
    if (options?.schema !== undefined) {
      await executor.execute(sql`set local search_path to ${sql.identifier(options.schema)}`);
    }

    if (!(await tryRestoreLock(executor))) {
      throw new ConflictError("Another restore holds the restore lock", {
        userMessage: "Another restore is already running. Wait for it to finish.",
        context: { restoreLock: true },
      });
    }

    /* No application write can interleave with the restore from here to commit. */
    await lockBackedUpTables(executor);

    const before = await measure(executor);
    const result = await apply(executor, loaded.value, orphanIds);
    const after = await measure(executor);

    return { ...result, effects: effectsBetween(before, after) };
  });

  if (!outcome.ok) {
    await auditRestore(
      backupId,
      {
        event: "restore_failed",
        reason: outcome.error.code,
        ...(safetySnapshotId ? { safetySnapshotId } : {}),
      },
      context,
    );

    return fail(
      /* Only the lock conflict passes through as itself; a constraint conflict is a failed restore. */
      isAppError(outcome.error) && outcome.error.context?.["restoreLock"] === true
        ? outcome.error
        : new ValidationError("Restore failed and was rolled back", {
            cause: outcome.error,
            userMessage: `The restore failed and was rolled back — nothing was changed (${databaseReason(outcome.error)}).`,
          }),
    );
  }

  await auditRestore(
    backupId,
    {
      event: "restored",
      orphans: orphans.value.length,
      nulledReferences: outcome.value.nulledReferences,
      skippedRows: outcome.value.skippedRows,
      ...(safetySnapshotId ? { safetySnapshotId } : {}),
    },
    context,
  );

  return ok({
    backupId,
    applied: outcome.value.applied,
    orphans: orphans.value,
    nulledReferences: outcome.value.nulledReferences,
    skippedRows: outcome.value.skippedRows,
    effects: outcome.value.effects,
    safetySnapshotId,
  });
}

export const restoreService = { preview, restore } as const;
