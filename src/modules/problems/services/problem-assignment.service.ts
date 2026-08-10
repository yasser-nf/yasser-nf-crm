import "server-only";

import { PERMISSIONS, USER_ROLES, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import type { IssueRow } from "@/lib/drizzle/schema";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { auditService, type AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { problemsRepository } from "../repositories/problems.repository";
import { assignProblemSchema } from "../validation/problem.schema";

/**
 * Problem assignment.
 *
 * Assign, unassign and reassign. Its own service because ownership decides what
 * a Worker may do everywhere else in this module — the rules about who may
 * change ownership deserve to be readable in one place rather than buried in a
 * general update.
 *
 * Assignment history is not a table. Every change here writes an audit entry
 * with before and after, and the timeline reads them back — ADR-010 Decision 3.
 * A parallel assignment_history table would record the same fact twice and the
 * two could disagree.
 */

function isSuperAdmin(actor: AppUser): boolean {
  return actor.role === USER_ROLES.SUPER_ADMIN;
}

/**
 * Who may change an assignment.
 *
 * Three cases, and the middle one is the reason this is not a single check:
 *
 *   Super Admin       may assign anything to anyone
 *   Worker, unowned   may claim it for themselves — otherwise nothing a Worker
 *                     reports could ever be worked on without an admin
 *   Worker, owned     may only release their own; the brief forbids reassigning
 *                     problems they do not own
 */
function assertMayAssign(
  actor: AppUser,
  problem: IssueRow,
  nextAssignee: string | null,
): Result<true> {
  if (isSuperAdmin(actor)) {
    return ok(true);
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.VIEW_PROBLEMS)) {
    return fail(new ForbiddenError("Role may not touch problems"));
  }

  const currentlyMine = problem.assignedTo === actor.id;
  const claimingForSelf = nextAssignee === actor.id;

  if (problem.assignedTo === null && claimingForSelf) {
    return ok(true);
  }

  if (currentlyMine && nextAssignee === null) {
    return ok(true);
  }

  return fail(
    new ForbiddenError(`Worker ${actor.id} may not reassign problem ${problem.id}`, {
      userMessage: currentlyMine
        ? "You can release a problem, but only a Super Admin can hand it to someone else."
        : "You can only claim problems that nobody is working on.",
    }),
  );
}

/**
 * Sets or clears the assignee.
 *
 * One operation for assign, unassign and reassign, because they are the same
 * write with a different target. Splitting them would triple the permission
 * logic without changing what happens.
 */
async function assign(
  id: string,
  input: unknown,
  context: AuditContext,
): Promise<Result<IssueRow>> {
  if (!context.actor) {
    return fail(new ForbiddenError("No signed-in user for an assignment"));
  }

  const parsed = assignProblemSchema.safeParse(input);

  if (!parsed.success) {
    return fail(new ValidationError("Assignment input is not valid"));
  }

  const before = await problemsRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  /*
   * A finished problem is not work anybody should be picking up. Allowing it
   * would put a live assignment on something nobody is going to do.
   */
  if (before.value.status === "closed" || before.value.status === "cancelled") {
    return fail(
      new ValidationError(`Cannot assign a ${before.value.status} problem`, {
        userMessage: `This problem is ${before.value.status} and cannot be assigned.`,
      }),
    );
  }

  const allowed = assertMayAssign(context.actor, before.value, parsed.data.assignedTo);

  if (!allowed.ok) {
    return allowed;
  }

  if (before.value.assignedTo === parsed.data.assignedTo) {
    return ok(before.value);
  }

  const updated = await problemsRepository.update(id, { assignedTo: parsed.data.assignedTo });

  if (!updated.ok) {
    return updated;
  }

  await auditService.recordOrWarn(
    { entity: "issue", entityId: id, action: "update", before: before.value, after: updated.value },
    context,
  );

  return updated;
}

/** Convenience for the common case: a Worker picking up unassigned work. */
async function claim(id: string, context: AuditContext): Promise<Result<IssueRow>> {
  if (!context.actor) {
    return fail(new ForbiddenError("No signed-in user to claim a problem"));
  }

  return assign(id, { assignedTo: context.actor.id }, context);
}

async function unassign(id: string, context: AuditContext): Promise<Result<IssueRow>> {
  return assign(id, { assignedTo: null }, context);
}

export const problemAssignmentService = { assign, claim, unassign } as const;
