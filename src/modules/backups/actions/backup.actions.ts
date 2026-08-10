"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import type { AppError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import { backupService } from "../services/backup.service";
import {
  restoreService,
  type RestoreOutcome,
  type RestorePreview,
} from "../services/restore.service";
import { snapshotService } from "../services/snapshot.service";

/**
 * Backup Server Actions. ADR-006 Decision 3: the network boundary.
 *
 * Actions hold no business logic. They resolve the caller, call one service
 * method, and translate a Result into something that survives serialisation to
 * the client. Every authorization decision is made in the service, because an
 * action is a POST endpoint and hiding a button protects nothing.
 */

export interface ActionFailure {
  readonly ok: false;
  readonly message: string;
  readonly code: string;
}

export type ActionResult<T> = { readonly ok: true; readonly data: T } | ActionFailure;

function toFailure(error: AppError): ActionFailure {
  return { ok: false, message: error.userMessage, code: error.code };
}

async function auditContext(): Promise<AuditContext> {
  const actor = await getCurrentUser();
  const headerList = await headers();

  const forwarded = headerList.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || headerList.get("x-real-ip") || null;
  const agent = headerList.get("user-agent");

  return {
    actor,
    ...(ip ? { ipAddress: ip } : {}),
    ...(agent ? { userAgent: agent } : {}),
  };
}

export async function createBackupAction(
  type: "manual" | "snapshot",
): Promise<ActionResult<{ id: string; name: string }>> {
  const context = await auditContext();
  const result =
    type === "snapshot"
      ? await snapshotService.take(context)
      : await backupService.create({ type }, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidatePath(ROUTES.BACKUPS);

  return { ok: true, data: { id: result.value.id, name: result.value.name } };
}

export async function verifyBackupAction(id: string): Promise<ActionResult<{ status: string }>> {
  const context = await auditContext();
  const result = await backupService.verify(id, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidatePath(ROUTES.BACKUPS);

  return { ok: true, data: { status: result.value.status } };
}

/**
 * Returns a short-lived signed URL rather than the file.
 *
 * A Server Action returning many megabytes would be serialised through the RSC
 * payload. The browser downloads from storage directly instead.
 */
export async function exportBackupAction(id: string): Promise<ActionResult<{ url: string }>> {
  const actor = await getCurrentUser();
  const result = await backupService.exportUrl(id, actor);

  if (!result.ok) {
    return toFailure(result.error);
  }

  return { ok: true, data: { url: result.value } };
}

export async function importBackupAction(
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return { ok: false, message: "No file was provided.", code: "VALIDATION_ERROR" };
  }

  const context = await auditContext();
  const body = Buffer.from(await file.arrayBuffer());
  const result = await backupService.importArtifact(body, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidatePath(ROUTES.BACKUPS);

  return { ok: true, data: { id: result.value.id } };
}

export async function previewRestoreAction(id: string): Promise<ActionResult<RestorePreview>> {
  const actor = await getCurrentUser();
  const result = await restoreService.preview(id, actor);

  if (!result.ok) {
    return toFailure(result.error);
  }

  return { ok: true, data: result.value };
}

/**
 * Applies a restore.
 *
 * Takes a snapshot first. If the restore turns out to be the wrong decision,
 * that snapshot is the only way back — and it has to exist before the data is
 * overwritten, not after.
 */
export async function restoreBackupAction(id: string): Promise<ActionResult<RestoreOutcome>> {
  const context = await auditContext();

  const safety = await snapshotService.take(context);

  if (!safety.ok) {
    return toFailure(safety.error);
  }

  const result = await restoreService.restore(id, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidatePath(ROUTES.BACKUPS);

  return { ok: true, data: result.value };
}
