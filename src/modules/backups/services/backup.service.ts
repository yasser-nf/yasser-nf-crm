import "server-only";

import { sql } from "drizzle-orm";

import { APP_VERSION } from "@/config/constants";
import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { databaseAdapter, type Page } from "@/lib/database";
import type { BackupRow } from "@/lib/drizzle/schema";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { auditService, type AuditContext } from "@/modules/audit";
import { settingsRepository } from "@/modules/settings";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import {
  backupsRepository,
  type BackupFilter,
  type BackupListEntry,
} from "../repositories/backups.repository";
import { backupStorage } from "../storage/backup-storage";
import {
  backupArtifactSchema,
  createBackupSchema,
  parseBackupSettings,
  type BackupSettings,
} from "../validation/backup.schema";
import { readArtifact, writeArtifact } from "./artifact-writer";
import { BACKUP_FORMAT_VERSION, BACKUP_TABLE_NAMES, checkCompatibility } from "./backup-format";
import { checksumService } from "./checksum.service";
import { planRetention } from "./retention";

/**
 * Backup service.
 *
 * Creating, listing, verifying, exporting, importing and pruning backups.
 * Restoring lives in restore.service.ts — reading and writing are different
 * risks and deserve different files.
 *
 * Every method starts with the same permission check. 01_MASTER_RULES.md:
 * Workers cannot access backup. That is enforced here, not in the page, because
 * a Server Action is a POST endpoint anyone holding a session can call.
 */

function requireBackupAccess(actor: AppUser | null, action: string): Result<AppUser> {
  if (!actor) {
    return fail(new ForbiddenError(`No signed-in user for ${action}`));
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.ACCESS_BACKUPS)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not ${action}`, {
        userMessage: "Backups are restricted to Super Admins.",
        context: { actorId: actor.id, role: actor.role },
      }),
    );
  }

  return ok(actor);
}

async function databaseVersion(): Promise<string> {
  const result = await databaseAdapter.query("backups.databaseVersion", async (executor) => {
    const rows = await executor.execute(sql`select version() as version`);
    return (rows as unknown as { version: string }[])[0]?.version ?? "unknown";
  });

  return result.ok ? result.value : "unknown";
}

function backupName(type: string, at: Date): string {
  return `${type}-${at.toISOString().replace(/[:.]/g, "-")}`;
}

async function list(
  filter: BackupFilter,
  actor: AppUser | null,
): Promise<Result<Page<BackupListEntry>>> {
  const permitted = requireBackupAccess(actor, "view backups");

  if (!permitted.ok) {
    return permitted;
  }

  return backupsRepository.list(filter);
}

async function getDetail(id: string, actor: AppUser | null): Promise<Result<BackupRow>> {
  const permitted = requireBackupAccess(actor, "view a backup");

  if (!permitted.ok) {
    return permitted;
  }

  return backupsRepository.findById(id);
}

/**
 * Creates a backup.
 *
 * The metadata row is written first, as `pending`, so a crash mid-write leaves a
 * visible unfinished backup rather than no trace at all. A backup system whose
 * failures are invisible is worse than one that has none.
 */
async function create(input: unknown, context: AuditContext): Promise<Result<BackupRow>> {
  const permitted = requireBackupAccess(context.actor, "create backups");

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = createBackupSchema.safeParse(input);

  if (!parsed.success) {
    return fail(new ValidationError("Backup input is not valid"));
  }

  const type = parsed.data.type;
  const startedAt = new Date();

  const created = await backupsRepository.create({
    name: backupName(type, startedAt),
    type,
    status: "running",
    /* A snapshot is a deliberate marker, so it is a restore point by definition. */
    isRestorePoint: type === "snapshot",
    createdBy: context.actor?.id ?? null,
    formatVersion: BACKUP_FORMAT_VERSION,
  });

  if (!created.ok) {
    return created;
  }

  const backupId = created.value.id;

  try {
    const dbVersion = await databaseVersion();

    const artifact = await writeArtifact({
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: startedAt.toISOString(),
      createdBy: context.actor?.id ?? null,
      appVersion: APP_VERSION,
      databaseVersion: dbVersion,
      type,
      tables: BACKUP_TABLE_NAMES,
    });

    const checksum = checksumService.of(artifact.body);
    const uploaded = await backupStorage.upload(backupId, artifact.body);

    if (!uploaded.ok) {
      await backupsRepository.markFailed(backupId, uploaded.error.message);
      return uploaded;
    }

    const completed = await backupsRepository.markCompleted(backupId, {
      filename: uploaded.value.path,
      checksum,
      sizeBytes: artifact.body.byteLength,
      tableCounts: artifact.rowCounts,
      appVersion: APP_VERSION,
      databaseVersion: dbVersion,
    });

    if (!completed.ok) {
      return completed;
    }

    await auditService.recordOrWarn(
      { entity: "backup", entityId: backupId, action: "create", after: completed.value },
      context,
    );

    /* Retention runs after a successful backup, never before: pruning first
     * could leave the system with fewer backups than the policy promises if the
     * new one then failed. */
    await pruneByRetention(context);

    return completed;
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : "Unknown backup failure";
    await backupsRepository.markFailed(backupId, reason);

    return fail(
      new ValidationError(`Backup failed: ${reason}`, {
        cause: caught,
        userMessage: "The backup could not be completed.",
      }),
    );
  }
}

/**
 * Verifies a stored backup against its recorded checksum.
 *
 * 01_MASTER_RULES.md requires backups to be verifiable. `completed` means the
 * bytes were written; `verified` means they were read back and still hash to
 * what was recorded. Treating the two as the same is how an organisation
 * discovers during an incident that its backups were empty.
 */
async function verify(id: string, context: AuditContext): Promise<Result<BackupRow>> {
  const permitted = requireBackupAccess(context.actor, "verify backups");

  if (!permitted.ok) {
    return permitted;
  }

  const backup = await backupsRepository.findById(id);

  if (!backup.ok) {
    return backup;
  }

  if (!backup.value.filename || !backup.value.checksum) {
    return fail(
      new ValidationError("Backup has no stored artifact to verify", {
        userMessage: "This backup has no file to verify.",
      }),
    );
  }

  const body = await backupStorage.download(backup.value.filename);

  if (!body.ok) {
    await backupsRepository.markFailed(id, "Artifact missing from storage");
    return body;
  }

  const actual = checksumService.of(body.value);

  if (!checksumService.matches(backup.value.checksum, actual)) {
    await backupsRepository.markFailed(id, "Checksum mismatch: the stored file has changed");

    return fail(
      new ValidationError(`Checksum mismatch on backup ${id}`, {
        userMessage: "This backup is corrupted — its contents no longer match its checksum.",
      }),
    );
  }

  return backupsRepository.markVerified(id);
}

/** A short-lived signed URL. The bucket itself stays private. */
async function exportUrl(id: string, actor: AppUser | null): Promise<Result<string>> {
  const permitted = requireBackupAccess(actor, "export backups");

  if (!permitted.ok) {
    return permitted;
  }

  const backup = await backupsRepository.findById(id);

  if (!backup.ok) {
    return backup;
  }

  if (!backup.value.filename) {
    return fail(
      new ValidationError("Backup has no artifact", {
        userMessage: "This backup has no file to download.",
      }),
    );
  }

  return backupStorage.signedUrl(backup.value.filename);
}

/**
 * Imports a backup file.
 *
 * The file is untrusted input. It is validated before it is stored, and stored
 * before it can be restored — importing never applies anything to the database.
 */
async function importArtifact(body: Buffer, context: AuditContext): Promise<Result<BackupRow>> {
  const permitted = requireBackupAccess(context.actor, "import backups");

  if (!permitted.ok) {
    return permitted;
  }

  let parsedDocument: unknown;

  try {
    parsedDocument = readArtifact(body);
  } catch (caught) {
    return fail(
      new ValidationError("Import file is not a readable backup", {
        cause: caught,
        userMessage: "That file is not a valid backup — it could not be decompressed or parsed.",
      }),
    );
  }

  const artifact = backupArtifactSchema.safeParse(parsedDocument);

  if (!artifact.success) {
    return fail(
      new ValidationError("Import file failed schema validation", {
        userMessage: "That file is not a valid backup — its structure is wrong.",
      }),
    );
  }

  const compatibility = checkCompatibility(artifact.data.manifest);

  if (!compatibility.compatible) {
    return fail(
      new ValidationError(`Incompatible backup: ${compatibility.reason}`, {
        userMessage: compatibility.reason,
      }),
    );
  }

  const checksum = checksumService.of(body);
  const now = new Date();

  const created = await backupsRepository.create({
    name: `imported-${now.toISOString().replace(/[:.]/g, "-")}`,
    type: "manual",
    status: "running",
    /* Imports are kept: someone deliberately brought this file into the system. */
    isRestorePoint: true,
    createdBy: context.actor?.id ?? null,
    formatVersion: artifact.data.manifest.formatVersion,
  });

  if (!created.ok) {
    return created;
  }

  const uploaded = await backupStorage.upload(created.value.id, body);

  if (!uploaded.ok) {
    await backupsRepository.markFailed(created.value.id, uploaded.error.message);
    return uploaded;
  }

  const completed = await backupsRepository.markCompleted(created.value.id, {
    filename: uploaded.value.path,
    checksum,
    sizeBytes: body.byteLength,
    tableCounts: artifact.data.manifest.rowCounts,
    appVersion: artifact.data.manifest.appVersion,
    databaseVersion: artifact.data.manifest.databaseVersion,
  });

  if (completed.ok) {
    await auditService.recordOrWarn(
      { entity: "backup", entityId: created.value.id, action: "create", after: completed.value },
      context,
    );
  }

  return completed;
}

/** Reads the schedule and retention policy from the settings singleton. */
async function readSettings(actor: AppUser | null): Promise<Result<BackupSettings>> {
  const permitted = requireBackupAccess(actor, "view backup settings");

  if (!permitted.ok) {
    return permitted;
  }

  const row = await settingsRepository.ensureExists();

  if (!row.ok) {
    return row;
  }

  return ok(parseBackupSettings(row.value.values));
}

/**
 * Applies the retention policy.
 *
 * Deletes the artifact first, then the row. The other order can leave an
 * orphaned object in storage with nothing pointing at it — invisible, and
 * charged for forever.
 */
async function pruneByRetention(context: AuditContext): Promise<Result<number>> {
  const settingsRow = await settingsRepository.ensureExists();

  if (!settingsRow.ok) {
    return settingsRow;
  }

  const policy = parseBackupSettings(settingsRow.value.values).retention;
  const candidates = await backupsRepository.retentionCandidates();

  if (!candidates.ok) {
    return candidates;
  }

  const plan = planRetention(candidates.value, policy.keepLast);

  if (plan.prune.length === 0) {
    return ok(0);
  }

  const doomed = await backupsRepository.deleteMany(plan.prune);

  if (!doomed.ok) {
    return doomed;
  }

  for (const row of doomed.value) {
    if (row.filename) {
      await backupStorage.remove(row.filename);
    }

    await auditService.recordOrWarn(
      { entity: "backup", entityId: row.id, action: "delete", before: row },
      context,
    );
  }

  return ok(doomed.value.length);
}

export const backupService = {
  list,
  getDetail,
  create,
  verify,
  exportUrl,
  importArtifact,
  readSettings,
  pruneByRetention,
} as const;
