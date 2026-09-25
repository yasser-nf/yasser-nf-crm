import "server-only";

import { USER_ROLES } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import type { IssueRow } from "@/lib/drizzle/schema";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { auditService, type AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { problemsRepository } from "../repositories/problems.repository";
import { reopenProblemSchema, resolveProblemSchema } from "../validation/problem.schema";
import { canTransition, explainRefusal } from "./problem-lifecycle";
import { problemNotifications } from "./problem-notifications";
import { assertMayMutate } from "./problems.service";

/**
 * Problem resolution.
 *
 * Resolve, reopen, close and cancel â€” the four transitions that carry
 * consequences beyond the status column. `problemsService.update` deliberately
 * refuses resolve and reopen and points here, so the resolution note and the
 * reopen counter have exactly one code path each.
 */

function isSuperAdmin(actor: AppUser): boolean {
  return actor.role === USER_ROLES.SUPER_ADMIN;
}

/**
 * Loads a problem and the actor allowed to change it.
 *
 * Returns both so callers never need a non-null assertion on `context.actor`:
 * the null check happens here, and the narrowed actor comes back with the row.
 */
async function loadForMutation(
  id: string,
  actor: AppUser | null,
  action: string,
): Promise<Result<{ problem: IssueRow; actor: AppUser }>> {
  if (!actor) {
    return fail(new ForbiddenError(`No signed-in user to ${action} a problem`));
  }

  const problem = await problemsRepository.findById(id);

  if (!problem.ok) {
    return problem;
  }

  const allowed = assertMayMutate(actor, problem.value, action);

  if (!allowed.ok) {
    return allowed;
  }

  return ok({ problem: problem.value, actor });
}

/**
 * Resolves a problem.
 *
 * The resolution note is mandatory â€” required by the M08 brief, enforced by the
 * Zod schema here AND by a check constraint on the table. Two layers because a
 * "resolved" nobody explained is indistinguishable from one nobody fixed, and
 * the next person to hit the same fault learns nothing from it.
 */
async function resolve(
  id: string,
  input: unknown,
  context: AuditContext,
): Promise<Result<IssueRow>> {
  const loaded = await loadForMutation(id, context.actor, "resolve");

  if (!loaded.ok) {
    return loaded;
  }

  const { problem: before, actor } = loaded.value;

  const parsed = resolveProblemSchema.safeParse(input);

  if (!parsed.success) {
    return fail(
      new ValidationError("A resolution note is required", {
        fieldErrors: { resolutionNote: parsed.error.issues[0]?.message ?? "Required" },
      }),
    );
  }

  if (!canTransition(before.status, "resolved", isSuperAdmin(actor))) {
    return fail(
      new ValidationError(`Illegal transition ${before.status} -> resolved`, {
        userMessage: explainRefusal(before.status, "resolved"),
      }),
    );
  }

  const updated = await problemsRepository.update(id, {
    status: "resolved",
    resolutionNote: parsed.data.resolutionNote,
    resolvedBy: actor.id,
    resolvedAt: new Date(),
  });

  if (!updated.ok) {
    return updated;
  }

  await auditService.recordOrWarn(
    { entity: "issue", entityId: id, action: "update", before: before, after: updated.value },
    context,
  );

  await problemNotifications.resolved(updated.value, context);

  return updated;
}

/**
 * Reopens a resolved or closed problem.
 *
 * Increments `reopen_count`, which is the whole point: a fault that keeps
 * coming back is a different signal from one that happened once, and that is
 * only visible if returns are counted rather than just re-dated.
 *
 * The previous resolution note is cleared. Keeping it would leave the row
 * claiming a resolution that demonstrably did not hold â€” and the old note
 * survives in the audit trail, which is where history belongs.
 */
async function reopen(
  id: string,
  input: unknown,
  context: AuditContext,
): Promise<Result<IssueRow>> {
  const loaded = await loadForMutation(id, context.actor, "reopen");

  if (!loaded.ok) {
    return loaded;
  }

  const { problem: before, actor } = loaded.value;

  const parsed = reopenProblemSchema.safeParse(input);

  if (!parsed.success) {
    return fail(
      new ValidationError("A reason is required to reopen", {
        fieldErrors: { reason: parsed.error.issues[0]?.message ?? "Required" },
      }),
    );
  }

  if (!canTransition(before.status, "open", isSuperAdmin(actor))) {
    return fail(
      new ValidationError(`Illegal transition ${before.status} -> open`, {
        userMessage: explainRefusal(before.status, "open"),
      }),
    );
  }

  const updated = await problemsRepository.update(id, {
    status: "open",
    reopenCount: before.reopenCount + 1,
    resolutionNote: null,
    resolvedAt: null,
    resolvedBy: null,
    closedAt: null,
  });

  if (!updated.ok) {
    return updated;
  }

  await auditService.recordOrWarn(
    { entity: "issue", entityId: id, action: "restore", before: before, after: updated.value },
    context,
  );

  /* The reason belongs in the record, not only in the audit diff. */
  await problemsRepository.addNote({
    issueId: id,
    userId: actor.id,
    body: `Reopened: ${parsed.data.reason}`,
  });

  await problemNotifications.reopened(updated.value, context);

  return updated;
}

/** Closes a resolved problem, or a cancelled one if the actor is a Super Admin. */
async function close(id: string, context: AuditContext): Promise<Result<IssueRow>> {
  const loaded = await loadForMutation(id, context.actor, "close");

  if (!loaded.ok) {
    return loaded;
  }

  const { problem: before, actor } = loaded.value;

  /*
   * The M08 brief states Workers may not close cancelled problems, which
   * implies a Super Admin can â€” so that one edge is role-dependent and lives in
   * the lifecycle graph rather than here.
   */
  if (!canTransition(before.status, "closed", isSuperAdmin(actor))) {
    return fail(
      new ValidationError(`Illegal transition ${before.status} -> closed`, {
        userMessage: explainRefusal(before.status, "closed"),
      }),
    );
  }

  const updated = await problemsRepository.update(id, {
    status: "closed",
    closedAt: new Date(),
  });

  if (!updated.ok) {
    return updated;
  }

  await auditService.recordOrWarn(
    { entity: "issue", entityId: id, action: "update", before: before, after: updated.value },
    context,
  );

  return updated;
}

/** Cancels a problem that should never have been raised. Terminal. */
async function cancel(id: string, context: AuditContext): Promise<Result<IssueRow>> {
  const loaded = await loadForMutation(id, context.actor, "cancel");

  if (!loaded.ok) {
    return loaded;
  }

  const { problem: before, actor } = loaded.value;

  if (!canTransition(before.status, "cancelled", isSuperAdmin(actor))) {
    return fail(
      new ValidationError(`Illegal transition ${before.status} -> cancelled`, {
        userMessage: explainRefusal(before.status, "cancelled"),
      }),
    );
  }

  const updated = await problemsRepository.update(id, { status: "cancelled" });

  if (!updated.ok) {
    return updated;
  }

  await auditService.recordOrWarn(
    { entity: "issue", entityId: id, action: "update", before: before, after: updated.value },
    context,
  );

  return ok(updated.value);
}

export const problemResolutionService = { resolve, reopen, close, cancel } as const;
