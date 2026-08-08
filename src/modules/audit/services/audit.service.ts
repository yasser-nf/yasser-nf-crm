import "server-only";

import type { AppUser } from "@/lib/auth";
import { logger } from "@/lib/logger";
import type { AuditLogRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import { auditRepository } from "../repositories/audit.repository";
import type { AuditLogInsert } from "../validation/audit-log.schema";

/**
 * Audit service.
 *
 * 01_MASTER_RULES.md: every important action is logged, and the log is
 * immutable.
 *
 * The one thing this service exists to guarantee is that a secret never reaches
 * an audit row. Callers pass whole entity snapshots — the natural thing to do —
 * and a snapshot of an account row carries password_encrypted. Stripping is done
 * here rather than at each call site, because a rule applied in eight places is
 * a rule that will be missed in the ninth.
 */

/**
 * Columns that must never appear in an audit snapshot.
 *
 * password_encrypted is ciphertext rather than plaintext, but storing it in a
 * table that history views read freely would spread the secret to a second
 * place and defeat the point of encrypting it in the first.
 */
const REDACTED_FIELDS: readonly string[] = ["passwordEncrypted", "password_encrypted", "password"];

const REDACTION_MARKER = "[redacted]";

/** Removes forbidden fields from a snapshot before it is written. */
function redact(
  snapshot: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, unknown> | null {
  if (!snapshot) {
    return null;
  }

  const safe: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(snapshot)) {
    safe[key] = REDACTED_FIELDS.includes(key) ? REDACTION_MARKER : value;
  }

  return safe;
}

export interface AuditContext {
  readonly actor: AppUser | null;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface RecordAuditInput {
  readonly entity: AuditLogInsert["entity"];
  readonly entityId: string;
  readonly action: AuditLogInsert["action"];
  readonly before?: Readonly<Record<string, unknown>> | null | undefined;
  readonly after?: Readonly<Record<string, unknown>> | null | undefined;
}

/**
 * Writes an audit entry.
 *
 * Returns a Result so a caller inside a larger operation can decide what a
 * logging failure means. `recordOrWarn` below covers the common case.
 */
async function record(
  input: RecordAuditInput,
  context: AuditContext,
): Promise<Result<AuditLogRow>> {
  return auditRepository.record({
    entity: input.entity,
    entityId: input.entityId,
    action: input.action,
    before: redact(input.before),
    after: redact(input.after),
    userId: context.actor?.id ?? null,
    /* Denormalised so the entry still names someone after the user is deleted. */
    actorEmail: context.actor?.email,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
}

/**
 * Writes an audit entry, warning rather than failing if the write fails.
 *
 * Deliberate trade-off. A business operation that already succeeded must not be
 * reported to the user as failed because its audit row could not be written —
 * the account exists either way, and telling them otherwise would be a lie that
 * causes a duplicate.
 *
 * The failure is logged loudly so a broken audit trail is visible in operations
 * rather than silent. Where an action must not proceed without its audit entry,
 * call `record` and handle the Result.
 */
async function recordOrWarn(input: RecordAuditInput, context: AuditContext): Promise<void> {
  const result = await record(input, context);

  if (!result.ok) {
    logger.error("Audit entry could not be written", result.error, {
      entity: input.entity,
      entityId: input.entityId,
      action: input.action,
    });
  }
}

export const auditService = { record, recordOrWarn } as const;
