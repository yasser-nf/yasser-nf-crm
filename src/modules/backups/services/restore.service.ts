import "server-only";

import { sql } from "drizzle-orm";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { databaseAdapter } from "@/lib/database";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { auditService, type AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { backupsRepository } from "../repositories/backups.repository";
import {
  datasetRepository,
  deleteRows,
  idsOf,
  upsertRows,
  type DatasetRow,
} from "../repositories/dataset.repository";
import { backupStorage } from "../storage/backup-storage";
import { backupArtifactSchema } from "../validation/backup.schema";
import { readArtifact } from "./artifact-writer";
import {
  BACKUP_TABLES,
  NULLABLE_USER_REFERENCES,
  RESTORE_DELETE_ORDER,
  checkCompatibility,
  policyFor,
} from "./backup-format";
import { checksumService } from "./checksum.service";

/**
 * Restore service.
 *
 * Two operations, and the order between them is the whole design: nothing is
 * ever restored without a preview first. The M07 brief states it directly —
 * never restore immediately.
 *
 * The apply step runs inside exactly one transaction. If any table fails,
 * everything rolls back. There is no partial restore, by construction rather
 * than by care: the Database Adapter's transaction helper rolls back on a
 * thrown error, so a failure anywhere in the loop unwinds all of it.
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

export interface RestorePreview {
  readonly backupId: string;
  readonly checksumVerified: boolean;
  readonly changes: readonly TableChange[];
  readonly totals: { create: number; update: number; delete: number };
  readonly warnings: readonly string[];
  readonly conflicts: readonly string[];
  readonly orphans: readonly OrphanUser[];
}

export interface RestoreOutcome {
  readonly backupId: string;
  readonly applied: readonly TableChange[];
  readonly orphans: readonly OrphanUser[];
  readonly nulledReferences: number;
}

/**
 * Drill-only options.
 *
 * M12 P0-4: a backup system is only as good as its last successful restore, and
 * this one had never been run — `restoreService.restore` appeared in exactly one
 * test, checking that a Worker is refused. Proving it works needs somewhere safe
 * to point it, and there is no second database or Supabase project.
 *
 * `schema` redirects the apply transaction at a disposable schema, exactly as
 * `scripts/rollback-drill.mjs` already does for migrations: the Drizzle tables
 * are declared unqualified, so `search_path` decides where they resolve.
 *
 * Omitted — which is every production and application call — nothing is issued
 * and the transaction runs against the existing search_path. The default path is
 * byte-for-byte what it was.
 */
export interface RestoreOptions {
  /** A disposable schema to apply into. Never set outside a drill. */
  readonly schema?: string;
}

/**
 * A schema name safe to interpolate, checked rather than trusted.
 *
 * `sql.identifier` quotes it, but this is a drill seam reachable from a service,
 * and the cost of being wrong is a statement running somewhere unintended. The
 * allowlist is narrow on purpose: lower-case, digits and underscores only.
 */
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
  readonly data: Record<string, DatasetRow[]>;
  readonly warnings: readonly string[];
  readonly checksumVerified: boolean;
}

/**
 * Fetches, verifies and parses a stored backup.
 *
 * The checksum is verified before the content is trusted for anything. The M07
 * brief requires verification before restore, and this is the single place both
 * preview and apply obtain their data, so neither can skip it.
 */
async function load(backupId: string): Promise<Result<LoadedArtifact>> {
  const backup = await backupsRepository.findById(backupId);

  if (!backup.ok) {
    return backup;
  }

  if (!backup.value.filename || !backup.value.checksum) {
    return fail(
      new ValidationError("Backup has no artifact", {
        userMessage: "This backup has no file, so it cannot be restored.",
      }),
    );
  }

  const body = await backupStorage.download(backup.value.filename);

  if (!body.ok) {
    return body;
  }

  if (!checksumService.matches(backup.value.checksum, checksumService.of(body.value))) {
    return fail(
      new ValidationError(`Checksum mismatch on backup ${backupId}`, {
        userMessage: "This backup is corrupted — its checksum does not match. Restore refused.",
      }),
    );
  }

  let document: unknown;

  try {
    document = readArtifact(body.value);
  } catch (caught) {
    return fail(
      new ValidationError("Backup could not be decompressed", {
        cause: caught,
        userMessage: "This backup could not be read.",
      }),
    );
  }

  const parsed = backupArtifactSchema.safeParse(document);

  if (!parsed.success) {
    return fail(
      new ValidationError("Backup failed schema validation", {
        userMessage: "This backup's structure is not valid. Restore refused.",
      }),
    );
  }

  const compatibility = checkCompatibility(parsed.data.manifest);

  if (!compatibility.compatible) {
    return fail(new ValidationError(compatibility.reason, { userMessage: compatibility.reason }));
  }

  return ok({
    data: parsed.data.data as Record<string, DatasetRow[]>,
    warnings: compatibility.warnings,
    checksumVerified: true,
  });
}

function rowId(row: DatasetRow): string | null {
  const id = row["id"];
  return typeof id === "string" ? id : null;
}

/**
 * Identifies users that cannot be restored.
 *
 * public.users.id references auth.users(id). A backed-up user whose Supabase
 * Auth identity has since been deleted cannot be inserted at all. The approved
 * rule: skip that user, report it, and restore everything else — one deleted
 * identity must not make an otherwise good backup unrestorable.
 */
async function findOrphans(users: readonly DatasetRow[]): Promise<Result<OrphanUser[]>> {
  const ids = users.map(rowId).filter((id): id is string => id !== null);
  const existing = await datasetRepository.existingAuthUserIds(ids);

  if (!existing.ok) {
    return existing;
  }

  const orphans: OrphanUser[] = [];

  for (const row of users) {
    const id = rowId(row);

    if (id && !existing.value.has(id)) {
      orphans.push({
        id,
        email: typeof row["email"] === "string" ? row["email"] : "(unknown)",
        reason: "No Supabase Auth identity exists for this user any more.",
      });
    }
  }

  return ok(orphans);
}

/** Preview: what a restore would do, without doing any of it. */
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
    const rows = loaded.value.data[spec.table] ?? [];
    const current = await datasetRepository.readAll(spec.table);

    if (!current.ok) {
      return current;
    }

    const currentById = new Map(current.value.map((row) => [rowId(row) ?? "", row] as const));

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
        continue;
      }

      if (spec.policy === "append_only") {
        /* Present already and never rewritten — nothing to do. */
        continue;
      }

      if (JSON.stringify(existing) !== JSON.stringify(row)) {
        update += 1;
        conflicts.push(`${spec.table}: row ${id} differs from the backup and will be overwritten.`);
      }
    }

    const backupIds = new Set(rows.map(rowId).filter((id): id is string => id !== null));

    const removals =
      spec.policy === "reconcile"
        ? current.value.filter((row) => {
            const id = rowId(row);
            return id !== null && !backupIds.has(id);
          }).length
        : 0;

    if (spec.policy === "append_only") {
      const extra = current.value.filter((row) => {
        const id = rowId(row);
        return id !== null && !backupIds.has(id);
      }).length;

      if (extra > 0) {
        warnings.push(
          `${spec.table}: ${extra} row(s) recorded since this backup will be KEPT — ` +
            `this table is append-only and is never deleted from.`,
        );
      }
    }

    changes.push({
      table: spec.table,
      policy: spec.policy,
      create,
      update,
      delete: removals,
    });
  }

  for (const orphan of orphans.value) {
    warnings.push(`User ${orphan.email} cannot be restored: ${orphan.reason}`);
  }

  const totals = changes.reduce(
    (sum, change) => ({
      create: sum.create + change.create,
      update: sum.update + change.update,
      delete: sum.delete + change.delete,
    }),
    { create: 0, update: 0, delete: 0 },
  );

  /* Conflicts are capped: a list of ten thousand ids helps nobody decide. */
  return ok({
    backupId,
    checksumVerified: loaded.value.checksumVerified,
    changes,
    totals,
    warnings,
    conflicts: conflicts.slice(0, 50),
    orphans: orphans.value,
  });
}

/**
 * Applies a restore. All of it, or none of it.
 *
 * Deletes run children-first and inserts parents-first, so foreign keys hold at
 * every step. Everything is inside one transaction: a failure on the last table
 * unwinds the first.
 */
async function restore(
  backupId: string,
  context: AuditContext,
  options?: RestoreOptions,
): Promise<Result<RestoreOutcome>> {
  const permitted = requireBackupAccess(context.actor, "restore a backup");

  if (!permitted.ok) {
    return permitted;
  }

  if (options?.schema !== undefined && !SAFE_SCHEMA.test(options.schema)) {
    return fail(
      new ValidationError(`Refusing to restore into an unsafe schema name`, {
        userMessage: "That restore target is not a valid schema.",
      }),
    );
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

  const restorableUsers = (loaded.value.data["users"] ?? []).filter((row) => {
    const id = rowId(row);
    return id !== null && !orphanIds.has(id);
  });

  const applied: TableChange[] = [];
  let nulledReferences = 0;

  const outcome = await databaseAdapter.transaction("restore.apply", async (executor) => {
    /*
     * The FIRST statement, before a single row is read or written.
     *
     * `SET LOCAL` is scoped to this transaction and reverts on commit or
     * rollback, so it cannot leak onto a pooled connection and change where a
     * later caller writes. That property is why the redirect belongs here and
     * not around the transaction.
     */
    if (options?.schema !== undefined) {
      await executor.execute(sql`set local search_path to ${sql.identifier(options.schema)}`);
    }

    /*
     * Which user ids will exist once this transaction commits: the restorable
     * ones from the backup, plus any already present that the backup does not
     * mention. Anything pointing outside that set would violate a foreign key,
     * so those references are nulled rather than allowed to abort the restore.
     */
    const currentUserIds = await idsOf(executor, "users");
    const validUserIds = new Set<string>([
      ...restorableUsers.map((row) => rowId(row) ?? ""),
      ...currentUserIds,
    ]);

    for (const id of orphanIds) {
      validUserIds.delete(id);
    }

    /* Deletes first, children before parents. */
    for (const table of RESTORE_DELETE_ORDER) {
      if (policyFor(table) !== "reconcile") {
        continue;
      }

      const rows = loaded.value.data[table] ?? [];
      const keep = new Set(rows.map(rowId).filter((id): id is string => id !== null));
      const present = await idsOf(executor, table);
      const doomed = [...present].filter((id) => !keep.has(id));

      const removed = await deleteRows(executor, table, doomed);
      applied.push({ table, policy: "reconcile", create: 0, update: 0, delete: removed });
    }

    /* Then inserts and updates, parents before children. */
    for (const spec of BACKUP_TABLES) {
      const source =
        spec.table === "users" ? restorableUsers : (loaded.value.data[spec.table] ?? []);

      const sanitised = source.map((row) => {
        const references = NULLABLE_USER_REFERENCES.filter((ref) => ref.table === spec.table);

        if (references.length === 0) {
          return row;
        }

        const copy: DatasetRow = { ...row };

        for (const reference of references) {
          const value = copy[reference.column];

          if (typeof value === "string" && !validUserIds.has(value)) {
            copy[reference.column] = null;
            nulledReferences += 1;
          }
        }

        return copy;
      });

      const written = await upsertRows(executor, spec.table, sanitised, spec.policy);

      applied.push({
        table: spec.table,
        policy: spec.policy,
        create: written,
        update: 0,
        delete: 0,
      });
    }

    return true;
  });

  if (!outcome.ok) {
    return outcome;
  }

  await auditService.recordOrWarn(
    {
      entity: "backup",
      entityId: backupId,
      action: "restore",
      after: {
        event: "restored",
        orphans: orphans.value.length,
        nulledReferences,
      },
    },
    context,
  );

  return ok({
    backupId,
    applied,
    orphans: orphans.value,
    nulledReferences,
  });
}

export const restoreService = { preview, restore } as const;
