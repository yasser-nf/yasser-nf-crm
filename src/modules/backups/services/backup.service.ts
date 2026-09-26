import "server-only";

import { sql } from "drizzle-orm";

import { APP_VERSION } from "@/config/constants";
import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { databaseAdapter, type Page } from "@/lib/database";
import type { BackupRow } from "@/lib/drizzle/schema";
import {
  ForbiddenError,
  UnexpectedError,
  ValidationError,
  boundValues,
  isAppError,
  scrubErrorText,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { auditService, type AuditContext } from "@/modules/audit";
import { settingsRepository } from "@/modules/settings";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import {
  backupsRepository,
  type BackupFilter,
  type BackupListEntry,
} from "../repositories/backups.repository";
import { datasetRepository } from "../repositories/dataset.repository";
import { backupStorage } from "../storage/backup-storage";
import {
  backupArtifactSchema,
  createBackupSchema,
  parseBackupSettings,
  type BackupSettings,
} from "../validation/backup.schema";
import { readArtifact, writeArtifact } from "./artifact-writer";
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLE_NAMES,
  checkCompatibility,
  validateBackupStructure,
} from "./backup-format";
import { backupMacKey } from "./backup-key";
import { checksumService } from "./checksum.service";
import { planRetention } from "./retention";
import { INTERRUPTED_AFTER_MS, isScheduledBackupDue, nextSlot } from "./schedule";

/**
 * Backup service.
 *
 * Creating, listing, verifying, exporting, importing, pruning and scheduling
 * backups. Restoring lives in restore.service.ts — reading and writing are
 * different risks and deserve different files.
 *
 * Every PUBLIC method starts with the same permission check: backups are Super
 * Admin only (ACCESS_BACKUPS is absent from the Worker allow-list), enforced
 * here, because a Server Action is a POST endpoint anyone holding a session can
 * call. The two callers that are not a person — the scheduler endpoint and the
 * restore's safety snapshot — reach `runBackup` through their own guarded
 * paths (a secret, and a Super Admin already checked by the restore).
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

/**
 * The reason stored on a failed backup, safe to keep and to show.
 *
 * Built through the M06 scrubber — the one sanitisation path — so a failure
 * caused by a query never stores that query's bound values. The error's code
 * leads, so the row still says WHAT failed.
 */
export function safeFailureReason(error: unknown): string {
  if (isAppError(error)) {
    return `${error.code}: ${scrubErrorText(error.message, boundValues(error.cause))}`.slice(
      0,
      500,
    );
  }

  if (error instanceof Error) {
    return scrubErrorText(error.message, boundValues(error)).slice(0, 500);
  }

  return "Unknown backup failure";
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

async function recordFailure(
  backupId: string,
  type: BackupRow["type"],
  error: unknown,
  context: AuditContext,
): Promise<string> {
  const reason = safeFailureReason(error);

  await backupsRepository.markFailed(backupId, reason);
  /* Audited with the safe reason and never the payload: the M06 logs show it as text hidden. */
  await auditService.recordOrWarn(
    {
      entity: "backup",
      entityId: backupId,
      action: "create",
      after: { event: "backup_failed", type, status: "failed", errorMessage: reason },
    },
    context,
  );
  logger.error("Backup failed", error, { backupId, type });

  return reason;
}

/**
 * The backup engine, for every kind of backup.
 *
 * NOT permission-checked: callers are the public `create` (which checks), the
 * scheduler (authenticated by its secret) and the restore safety snapshot
 * (inside a restore already checked). Not exported from the module.
 *
 * The row is written first, as `running`, so a crash mid-write leaves a
 * visible unfinished backup rather than no trace — and the scheduler turns
 * such a row into a failure once it is plainly abandoned.
 */
async function runBackup(
  type: BackupRow["type"],
  context: AuditContext,
  options: { readonly isRestorePoint?: boolean; readonly prune?: boolean } = {},
): Promise<Result<BackupRow>> {
  const startedAt = new Date();

  const created = await backupsRepository.create({
    name: backupName(type, startedAt),
    type,
    status: "running",
    /* A snapshot is a deliberate marker, so it is a restore point by definition. */
    isRestorePoint: options.isRestorePoint ?? type === "snapshot",
    createdBy: context.actor?.id ?? null,
    formatVersion: BACKUP_FORMAT_VERSION,
  });

  if (!created.ok) {
    return created;
  }

  const backupId = created.value.id;

  try {
    const [dbVersion, schema] = await Promise.all([
      databaseVersion(),
      datasetRepository.schemaVersion(),
    ]);

    const artifact = await writeArtifact({
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: schema.ok && schema.value !== null ? schema.value : undefined,
      createdAt: startedAt.toISOString(),
      createdBy: context.actor?.id ?? null,
      appVersion: APP_VERSION,
      databaseVersion: dbVersion,
      type,
      tables: BACKUP_TABLE_NAMES,
    });

    if (!artifact.ok) {
      await recordFailure(backupId, type, artifact.error, context);
      return artifact;
    }

    const checksum = checksumService.of(artifact.value.body);
    const uploaded = await backupStorage.upload(backupId, artifact.value.body);

    if (!uploaded.ok) {
      await recordFailure(backupId, type, uploaded.error, context);
      return uploaded;
    }

    const completed = await backupsRepository.markCompleted(backupId, {
      filename: uploaded.value.path,
      checksum,
      sizeBytes: artifact.value.body.byteLength,
      tableCounts: artifact.value.rowCounts,
      appVersion: APP_VERSION,
      databaseVersion: dbVersion,
    });

    if (!completed.ok) {
      await recordFailure(backupId, type, completed.error, context);
      return completed;
    }

    await auditService.recordOrWarn(
      { entity: "backup", entityId: backupId, action: "create", after: completed.value },
      context,
    );

    /*
     * Retention runs after a successful backup, never before: pruning first
     * could leave fewer backups than the policy promises if this one failed.
     */
    if (options.prune !== false) {
      await applyRetention(context);
    }

    return completed;
  } catch (caught) {
    await recordFailure(backupId, type, caught, context);

    return fail(
      new UnexpectedError("Backup failed", {
        cause: caught,
        userMessage: "The backup could not be completed.",
      }),
    );
  }
}

/** Creates a backup on a Super Admin's request. */
async function create(input: unknown, context: AuditContext): Promise<Result<BackupRow>> {
  const permitted = requireBackupAccess(context.actor, "create backups");

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = createBackupSchema.safeParse(input);

  if (!parsed.success) {
    return fail(new ValidationError("Backup input is not valid"));
  }

  return runBackup(parsed.data.type, context);
}

/**
 * Verifies a stored backup: its file against the recorded checksum and, for a
 * version 2 file, its data against the content hash inside it.
 *
 * `completed` means the bytes were written; `verified` means they were read
 * back and still prove themselves.
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

  if (!checksumService.matches(backup.value.checksum, checksumService.of(body.value))) {
    await backupsRepository.markFailed(id, "Checksum mismatch: the stored file has changed");

    return fail(
      new ValidationError(`Checksum mismatch on backup ${id}`, {
        userMessage: "This backup is corrupted — its contents no longer match its checksum.",
      }),
    );
  }

  const proven = proveContent(body.value);

  if (!proven.ok) {
    await backupsRepository.markFailed(id, proven.error.message.slice(0, 500));
    return proven;
  }

  return backupsRepository.markVerified(id);
}

/**
 * Parses an artifact and proves it: structure, compatibility, content hash
 * (version 2) and internal consistency. Used by verify and import; the restore
 * does the same and more before writing anything.
 */
function proveContent(
  body: Buffer,
  options: { readonly requireAuthenticated?: boolean } = {},
): Result<{ warnings: readonly string[] }> {
  let document: unknown;

  try {
    document = readArtifact(body);
  } catch (caught) {
    return fail(
      new ValidationError("Backup is not a readable artifact", {
        cause: caught,
        userMessage: "That file is not a valid backup — it could not be decompressed or parsed.",
      }),
    );
  }

  const artifact = backupArtifactSchema.safeParse(document);

  if (!artifact.success) {
    return fail(
      new ValidationError("Backup failed schema validation", {
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

  const { manifest, data } = artifact.data;

  /*
   * An imported file has no trusted copy to compare with, so it must prove
   * itself with the backup key. Version 1 files carry no signature: they are
   * refused on import (backups already stored stay restorable — the catalogue
   * checksum vouches for those).
   */
  if (options.requireAuthenticated && !manifest.contentMac) {
    return fail(
      new ValidationError("Unauthenticated backup file refused on import", {
        userMessage:
          "Only version 2 backup files can be imported: older files cannot be authenticated.",
      }),
    );
  }

  if (
    manifest.contentMac &&
    !checksumService.matches(
      manifest.contentMac,
      checksumService.manifestMac(manifest, backupMacKey()),
    )
  ) {
    return fail(
      new ValidationError("Backup signature mismatch", {
        userMessage:
          "This backup's signature does not match — it was altered, or made by another installation.",
      }),
    );
  }

  if (manifest.contentSha256) {
    const actual = checksumService.contentSha256(manifest.tables, data);

    if (!checksumService.matches(manifest.contentSha256, actual)) {
      return fail(
        new ValidationError("Content hash mismatch", {
          userMessage:
            "This backup's data does not match its own content hash — it was altered or damaged.",
        }),
      );
    }
  }

  const problems = validateBackupStructure(manifest, data);

  if (problems.length > 0) {
    return fail(
      new ValidationError(`Backup is internally inconsistent: ${problems[0]}`, {
        userMessage: `This backup is not consistent: ${problems[0]}`,
      }),
    );
  }

  return ok({ warnings: compatibility.warnings });
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
 * The file is untrusted input. It is proven — structure, compatibility, content
 * hash, internal consistency — before it is stored, and stored before it can be
 * restored; importing never applies anything to the database.
 */
async function importArtifact(body: Buffer, context: AuditContext): Promise<Result<BackupRow>> {
  const permitted = requireBackupAccess(context.actor, "import backups");

  if (!permitted.ok) {
    return permitted;
  }

  const proven = proveContent(body, { requireAuthenticated: true });

  if (!proven.ok) {
    return proven;
  }

  const document = backupArtifactSchema.parse(readArtifact(body));
  const checksum = checksumService.of(body);
  const now = new Date();

  const created = await backupsRepository.create({
    name: `imported-${now.toISOString().replace(/[:.]/g, "-")}`,
    type: "manual",
    status: "running",
    /* Imports are kept: someone deliberately brought this file into the system. */
    isRestorePoint: true,
    createdBy: context.actor?.id ?? null,
    formatVersion: document.manifest.formatVersion,
  });

  if (!created.ok) {
    return created;
  }

  const uploaded = await backupStorage.upload(created.value.id, body);

  if (!uploaded.ok) {
    await backupsRepository.markFailed(created.value.id, safeFailureReason(uploaded.error));
    return uploaded;
  }

  const completed = await backupsRepository.markCompleted(created.value.id, {
    filename: uploaded.value.path,
    checksum,
    sizeBytes: body.byteLength,
    tableCounts: document.manifest.rowCounts,
    appVersion: document.manifest.appVersion,
    databaseVersion: document.manifest.databaseVersion,
  });

  if (completed.ok) {
    await auditService.recordOrWarn(
      { entity: "backup", entityId: created.value.id, action: "create", after: completed.value },
      context,
    );
  }

  return completed;
}

async function settings(): Promise<Result<BackupSettings>> {
  const row = await settingsRepository.ensureExists();

  if (!row.ok) {
    return row;
  }

  return ok(parseBackupSettings(row.value.values));
}

/** Reads the schedule and retention policy from the settings singleton. */
async function readSettings(actor: AppUser | null): Promise<Result<BackupSettings>> {
  const permitted = requireBackupAccess(actor, "view backup settings");

  if (!permitted.ok) {
    return permitted;
  }

  return settings();
}

/**
 * Applies the retention policy. Internal: runs after every successful backup.
 *
 * Safety rules, each enforced here or in the plan:
 *   - only successful backups compete for slots; a failure never evicts one
 *   - restore points and snapshots are never pruned (a restored-from backup is
 *     made a restore point when the restore starts)
 *   - at least one successful backup always survives (keepLast ≥ 1)
 *   - nothing is deleted while a restore holds the restore lock
 *   - the artifact is deleted after the row, and only for rows really deleted
 */
async function applyRetention(context: AuditContext): Promise<Result<number>> {
  const policy = await settings();

  if (!policy.ok) {
    return policy;
  }

  const candidates = await backupsRepository.retentionCandidates();

  if (!candidates.ok) {
    return candidates;
  }

  const plan = planRetention(candidates.value, policy.value.retention.keepLast);

  if (plan.prune.length === 0) {
    return ok(0);
  }

  /* Defensive: a plan that would leave no successful backup is never executed. */
  if (plan.keep.length === 0) {
    logger.warn("Retention plan refused: it would leave no successful backup", {
      candidates: candidates.value.length,
    });
    return ok(0);
  }

  const doomed = await backupsRepository.deleteMany(plan.prune);

  if (!doomed.ok) {
    return doomed;
  }

  if (doomed.value === null) {
    logger.info("Retention skipped: a restore is in progress");
    return ok(0);
  }

  for (const row of doomed.value) {
    if (row.filename) {
      const removed = await backupStorage.remove(row.filename);

      if (!removed.ok) {
        logger.warn("A pruned backup's file could not be removed", { backupId: row.id });
      }
    }

    await auditService.recordOrWarn(
      { entity: "backup", entityId: row.id, action: "delete", before: row },
      context,
    );
  }

  return ok(doomed.value.length);
}

/** Retention on a Super Admin's request. */
async function pruneByRetention(context: AuditContext): Promise<Result<number>> {
  const permitted = requireBackupAccess(context.actor, "prune backups");

  if (!permitted.ok) {
    return permitted;
  }

  return applyRetention(context);
}

export interface ScheduledRunOutcome {
  readonly ran: boolean;
  readonly reason: "schedule_off" | "not_due" | "already_running" | "completed" | "failed";
  readonly backupId?: string | undefined;
  readonly interruptedMarkedFailed: number;
}

/**
 * One tick of the automatic schedule (M07). Called by the scheduler endpoint,
 * which authenticates the caller with a secret — there is no person here, so
 * the backup is recorded as created by nobody ("System" in the Logs).
 *
 * Safe to call as often as the trigger likes: it runs a backup only when the
 * current slot has none (see schedule.ts) and never while another backup is
 * running. Two triggers arriving in the same instant could, in principle, both
 * pass those checks; the result is one extra backup, which is harmless and is
 * pruned by retention like any other — never a lost or corrupted one.
 */
async function runScheduled(now: Date = new Date()): Promise<Result<ScheduledRunOutcome>> {
  const current = await settings();

  if (!current.ok) {
    return current;
  }

  const { frequency, hourUtc } = current.value.schedule;

  /* A backup still `running` long after it started has lost its process. */
  const interrupted = await backupsRepository.failInterrupted(
    new Date(now.getTime() - INTERRUPTED_AFTER_MS),
    "Interrupted: the backup did not finish (its process ended before it completed).",
  );
  const interruptedMarkedFailed = interrupted.ok ? interrupted.value : 0;

  if (frequency === "off") {
    return ok({ ran: false, reason: "schedule_off", interruptedMarkedFailed });
  }

  const running = await backupsRepository.running();

  if (!running.ok) {
    return running;
  }

  if (running.value.length > 0) {
    return ok({ ran: false, reason: "already_running", interruptedMarkedFailed });
  }

  const last = await backupsRepository.lastSuccessful(["hourly", "daily", "weekly", "monthly"]);

  if (!last.ok) {
    return last;
  }

  if (!isScheduledBackupDue(frequency, hourUtc, last.value?.createdAt ?? null, now)) {
    return ok({ ran: false, reason: "not_due", interruptedMarkedFailed });
  }

  const context: AuditContext = { actor: null, userAgent: "scheduler" };
  const result = await runBackup(frequency, context);

  if (!result.ok) {
    return ok({ ran: true, reason: "failed", interruptedMarkedFailed });
  }

  return ok({
    ran: true,
    reason: "completed",
    backupId: result.value.id,
    interruptedMarkedFailed,
  });
}

export interface BackupSummary {
  readonly lastSuccessful: BackupRow | null;
  readonly lastFailed: BackupRow | null;
  readonly running: number;
  readonly successfulCount: number;
  readonly totalCount: number;
  readonly settings: BackupSettings;
  /** When the schedule's next slot falls; null when off. */
  readonly nextScheduledAt: Date | null;
}

/** What the Backups page's summary shows. Every read must succeed. */
async function summary(actor: AppUser | null, now = new Date()): Promise<Result<BackupSummary>> {
  const permitted = requireBackupAccess(actor, "view backups");

  if (!permitted.ok) {
    return permitted;
  }

  const [lastSuccessful, lastFailed, running, counts, current] = await Promise.all([
    backupsRepository.lastSuccessful(),
    backupsRepository.lastFailed(),
    backupsRepository.running(),
    backupsRepository.counts(),
    settings(),
  ]);

  if (!lastSuccessful.ok) return lastSuccessful;
  if (!lastFailed.ok) return lastFailed;
  if (!running.ok) return running;
  if (!counts.ok) return counts;
  if (!current.ok) return current;

  return ok({
    lastSuccessful: lastSuccessful.value,
    lastFailed: lastFailed.value,
    running: running.value.length,
    successfulCount: counts.value.successful,
    totalCount: counts.value.total,
    settings: current.value,
    nextScheduledAt: nextSlot(
      current.value.schedule.frequency,
      current.value.schedule.hourUtc,
      now,
    ),
  });
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
  summary,
} as const;

/**
 * Internal surface for the module's own server code: the restore service (its
 * safety snapshot) and the scheduler endpoint. Not exported from the barrel.
 */
export const backupEngine = { runBackup, runScheduled, applyRetention } as const;

/**
 * The one piece of the engine the rest of the application may reach: a
 * scheduler tick. It can only run a SCHEDULED backup, only when one is due,
 * and cannot restore, read or delete anything. The scheduler endpoint calls it
 * after authenticating the caller with CRON_SECRET.
 */
export const backupScheduler = { tick: runScheduled } as const;
