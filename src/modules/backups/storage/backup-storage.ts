import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { ExternalServiceError, NotFoundError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";

/**
 * Backup object storage.
 *
 * ADR-009 Decision 1: artifacts live in a private Supabase Storage bucket. The
 * `backups` table stores metadata and points at the object, exactly as its M02
 * comment anticipated.
 *
 * Vercel has no persistent filesystem, so writing to disk was never an option,
 * and storing multi-megabyte compressed dumps in PostgreSQL would bloat the
 * database this module exists to protect.
 *
 * The bucket is private and reached only with the service role key, which is
 * `server-only`. There is no public URL for a backup at any point: a CRM dump
 * contains every customer phone number and every encrypted account credential
 * in the system, so a leaked link would be a full breach.
 */

export const BACKUP_BUCKET = "backups";

/** Signed URLs are short-lived: a download link is for now, not for keeping. */
const SIGNED_URL_TTL_SECONDS = 60;

function storagePathFor(backupId: string): string {
  return `${backupId}.json.gz`;
}

/**
 * Ensures the bucket exists.
 *
 * Created private, and idempotent — a "already exists" response is success, not
 * an error, because two concurrent backups must not race each other into a
 * failure.
 */
async function ensureBucket(): Promise<Result<true>> {
  const admin = createSupabaseAdminClient();

  if (!admin.ok) {
    return admin;
  }

  const existing = await admin.value.storage.getBucket(BACKUP_BUCKET);

  if (existing.data) {
    return ok(true);
  }

  const created = await admin.value.storage.createBucket(BACKUP_BUCKET, { public: false });

  if (created.error && !/exists/i.test(created.error.message)) {
    return fail(
      new ExternalServiceError(`Could not create the backup bucket: ${created.error.message}`, {
        cause: created.error,
        userMessage: "Backup storage is not available. Check the Supabase project.",
      }),
    );
  }

  return ok(true);
}

/**
 * Uploads an artifact.
 *
 * Takes the compressed bytes. Supabase's JS client does not accept a Node
 * stream, so the gzipped buffer is handed over whole — the streaming that
 * matters happens upstream, where rows are paged out of PostgreSQL and gzipped
 * incrementally rather than the entire dataset being materialised as objects.
 * Recorded honestly in docs/BACKUP_MODULE.md rather than described as more than
 * it is.
 */
async function upload(backupId: string, body: Buffer): Promise<Result<{ path: string }>> {
  const ready = await ensureBucket();

  if (!ready.ok) {
    return ready;
  }

  const admin = createSupabaseAdminClient();

  if (!admin.ok) {
    return admin;
  }

  const path = storagePathFor(backupId);

  const uploaded = await admin.value.storage.from(BACKUP_BUCKET).upload(path, body, {
    contentType: "application/gzip",
    upsert: true,
  });

  if (uploaded.error) {
    return fail(
      new ExternalServiceError(`Backup upload failed: ${uploaded.error.message}`, {
        cause: uploaded.error,
        userMessage: "The backup could not be stored.",
      }),
    );
  }

  return ok({ path });
}

/** Downloads an artifact for restore, verification or export. */
async function download(path: string): Promise<Result<Buffer>> {
  const admin = createSupabaseAdminClient();

  if (!admin.ok) {
    return admin;
  }

  const file = await admin.value.storage.from(BACKUP_BUCKET).download(path);

  if (file.error || !file.data) {
    return fail(
      new NotFoundError(`Backup object missing: ${path}`, {
        cause: file.error,
        userMessage: "The backup file could not be found in storage.",
      }),
    );
  }

  return ok(Buffer.from(await file.data.arrayBuffer()));
}

/**
 * A short-lived signed download URL.
 *
 * Used for export. The bucket stays private; this grants one caller one minute
 * of access rather than making the object readable.
 */
async function signedUrl(path: string): Promise<Result<string>> {
  const admin = createSupabaseAdminClient();

  if (!admin.ok) {
    return admin;
  }

  const signed = await admin.value.storage
    .from(BACKUP_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (signed.error || !signed.data) {
    return fail(
      new ExternalServiceError(`Could not sign backup URL: ${signed.error?.message ?? "unknown"}`, {
        cause: signed.error,
        userMessage: "The download link could not be created.",
      }),
    );
  }

  return ok(signed.data.signedUrl);
}

/**
 * Removes an artifact.
 *
 * Used by retention. A missing object is treated as success: the goal is that
 * it is gone, and failing here would strand the metadata row forever.
 */
async function remove(path: string): Promise<Result<true>> {
  const admin = createSupabaseAdminClient();

  if (!admin.ok) {
    return admin;
  }

  const removed = await admin.value.storage.from(BACKUP_BUCKET).remove([path]);

  if (removed.error) {
    return fail(
      new ExternalServiceError(`Could not delete backup object: ${removed.error.message}`, {
        cause: removed.error,
        userMessage: "The backup file could not be deleted.",
      }),
    );
  }

  return ok(true);
}

export const backupStorage = {
  bucket: BACKUP_BUCKET,
  pathFor: storagePathFor,
  ensureBucket,
  upload,
  download,
  signedUrl,
  remove,
} as const;
