import "server-only";

import { PERMISSIONS, USER_ROLES, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import type { Page } from "@/lib/database";
import type { IssueRow } from "@/lib/drizzle/schema";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { auditService, type AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import {
  problemsRepository,
  type ProblemFilter,
  type ProblemListEntry,
} from "../repositories/problems.repository";
import { createProblemSchema, updateProblemSchema } from "../validation/problem.schema";
import { problemNotifications } from "./problem-notifications";
import {
  canTransition,
  explainRefusal,
  isReopen,
  requiresResolutionNote,
} from "./problem-lifecycle";

/**
 * Problems service.
 *
 * The M08 brief: this module is the single source of truth for every account
 * problem, and no module may create or resolve problems directly. That is why
 * the repository is never exported from the barrel — a caller holding it could
 * write an `issues` row without a transition check, an audit entry, or a
 * permission check, and all three are enforced here.
 *
 * Authorization has two layers, because the M08 brief splits them:
 *
 *   visibility  global — any signed-in staff member sees every problem
 *   mutability  ownership-based — a Worker may only change what is assigned
 *               to them
 *
 * Ownership cannot be a permission: it depends on the row. So permissions gate
 * the operation and `assertMayMutate` gates the row.
 */

function isSuperAdmin(actor: AppUser): boolean {
  return actor.role === USER_ROLES.SUPER_ADMIN;
}

function requirePermission(
  actor: AppUser | null,
  permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS],
  action: string,
): Result<AppUser> {
  if (!actor) {
    return fail(new ForbiddenError(`No signed-in user for ${action}`));
  }

  if (!roleHasPermission(actor.role, permission)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not ${action}`, {
        userMessage: "You do not have permission to do that.",
        context: { actorId: actor.id, role: actor.role, permission },
      }),
    );
  }

  return ok(actor);
}

/**
 * The ownership rule.
 *
 * A Super Admin may change any problem. A Worker may change only one assigned
 * to them — and an unassigned problem belongs to nobody, so a Worker cannot
 * change that either. Picking it up is an assignment, which is its own
 * operation with its own check.
 */
export function assertMayMutate(actor: AppUser, problem: IssueRow, action: string): Result<true> {
  if (isSuperAdmin(actor)) {
    return ok(true);
  }

  if (problem.assignedTo === actor.id) {
    return ok(true);
  }

  return fail(
    new ForbiddenError(`Worker ${actor.id} may not ${action} problem ${problem.id}`, {
      userMessage:
        problem.assignedTo === null
          ? "This problem is not assigned to you. Assign it to yourself first."
          : "You can only work on problems assigned to you.",
      context: { actorId: actor.id, assignedTo: problem.assignedTo },
    }),
  );
}

/** Visibility is global: every signed-in staff member may read every problem. */
async function list(
  filter: ProblemFilter,
  actor: AppUser | null,
): Promise<Result<Page<ProblemListEntry>>> {
  const permitted = requirePermission(actor, PERMISSIONS.VIEW_PROBLEMS, "view problems");

  if (!permitted.ok) {
    return permitted;
  }

  return problemsRepository.list(filter);
}

async function getDetail(id: string, actor: AppUser | null): Promise<Result<ProblemListEntry>> {
  const permitted = requirePermission(actor, PERMISSIONS.VIEW_PROBLEMS, "view a problem");

  if (!permitted.ok) {
    return permitted;
  }

  return problemsRepository.findDetail(id);
}

/**
 * Reports a problem.
 *
 * The only way an `issues` row is ever created. Callable from Accounts,
 * Profiles, Quick Prepare, the Customer screen and the Problems screen — all of
 * which reach it through this one method, so the audit entry and the account
 * health consequence happen exactly once regardless of where the report came
 * from.
 *
 * A Worker may report. They are the ones who hit a broken account while
 * preparing a subscription, and a system that made them ask someone else to
 * file it would simply not get the report.
 */
async function report(input: unknown, context: AuditContext): Promise<Result<IssueRow>> {
  const permitted = requirePermission(
    context.actor,
    PERMISSIONS.REPORT_PROBLEMS,
    "report problems",
  );

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = createProblemSchema.safeParse(input);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};

    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && !(field in fieldErrors)) {
        fieldErrors[field] = issue.message;
      }
    }

    return fail(new ValidationError("Problem input failed validation", { fieldErrors }));
  }

  const created = await problemsRepository.create({
    accountId: parsed.data.accountId,
    issueType: parsed.data.issueType,
    severity: parsed.data.severity,
    description: parsed.data.description,
    reportedBy: context.actor?.id ?? null,
    /* Self-assignment on report is opt-in, so nobody silently owns a problem. */
    assignedTo: parsed.data.assignToMe ? (context.actor?.id ?? null) : null,
    status: "open",
  });

  if (!created.ok) {
    return created;
  }

  await auditService.recordOrWarn(
    { entity: "issue", entityId: created.value.id, action: "create", after: created.value },
    context,
  );

  await problemNotifications.reported(created.value, context);

  return created;
}

/**
 * Changes status, severity or description.
 *
 * Severity is separated out by permission rather than by field: the M08 brief
 * states Workers may not change severity, and a single `update` that quietly
 * ignored the field would be a silent failure rather than a refusal.
 */
async function update(
  id: string,
  input: unknown,
  context: AuditContext,
): Promise<Result<IssueRow>> {
  const permitted = requirePermission(context.actor, PERMISSIONS.VIEW_PROBLEMS, "update problems");

  if (!permitted.ok) {
    return permitted;
  }

  const actor = permitted.value;
  const parsed = updateProblemSchema.safeParse(input);

  if (!parsed.success) {
    return fail(new ValidationError("Problem update is not valid"));
  }

  const before = await problemsRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  const allowed = assertMayMutate(actor, before.value, "update");

  if (!allowed.ok) {
    return allowed;
  }

  if (parsed.data.severity && parsed.data.severity !== before.value.severity) {
    const maySetSeverity = requirePermission(
      actor,
      PERMISSIONS.MANAGE_PROBLEMS,
      "change problem severity",
    );

    if (!maySetSeverity.ok) {
      return fail(
        new ForbiddenError("Workers may not change severity", {
          userMessage: "Only a Super Admin can change a problem's severity.",
        }),
      );
    }
  }

  const patch: Partial<IssueRow> = {};

  if (parsed.data.description !== undefined) {
    patch.description = parsed.data.description;
  }

  if (parsed.data.severity !== undefined) {
    patch.severity = parsed.data.severity;
  }

  if (parsed.data.status !== undefined && parsed.data.status !== before.value.status) {
    const to = parsed.data.status;

    if (!canTransition(before.value.status, to, isSuperAdmin(actor))) {
      return fail(
        new ValidationError(`Illegal transition ${before.value.status} -> ${to}`, {
          userMessage: explainRefusal(before.value.status, to),
        }),
      );
    }

    /*
     * Resolving and reopening carry consequences beyond the status column, so
     * they belong to ProblemResolutionService and are refused here. Allowing
     * both paths would mean two places that must agree about resolution notes
     * and the reopen counter.
     */
    if (requiresResolutionNote(to) || isReopen(before.value.status, to)) {
      return fail(
        new ValidationError("Resolution and reopening go through their own operations", {
          userMessage:
            to === "resolved"
              ? "Use Resolve, so the resolution note is recorded."
              : "Use Reopen, so the reopen count stays accurate.",
        }),
      );
    }

    patch.status = to;

    if (to === "closed") {
      patch.closedAt = new Date();
    }
  }

  if (Object.keys(patch).length === 0) {
    return ok(before.value);
  }

  const updated = await problemsRepository.update(id, patch);

  if (!updated.ok) {
    return updated;
  }

  await auditService.recordOrWarn(
    {
      entity: "issue",
      entityId: id,
      action: "update",
      before: before.value,
      after: updated.value,
    },
    context,
  );

  return updated;
}

/**
 * Deletes a problem. Super Admin only.
 *
 * The M08 brief lists deletion among the things a Worker may never do. It is a
 * hard delete rather than a soft one because a problem raised in error has no
 * history worth keeping — and the audit trail of its creation and deletion
 * survives in audit_logs regardless.
 */
async function remove(id: string, context: AuditContext): Promise<Result<IssueRow>> {
  const permitted = requirePermission(
    context.actor,
    PERMISSIONS.MANAGE_PROBLEMS,
    "delete problems",
  );

  if (!permitted.ok) {
    return permitted;
  }

  const before = await problemsRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  const removed = await problemsRepository.remove(id);

  if (!removed.ok) {
    return removed;
  }

  await auditService.recordOrWarn(
    { entity: "issue", entityId: id, action: "delete", before: before.value },
    context,
  );

  await problemNotifications.removed(id);

  return removed;
}

/**
 * Active problems for one account.
 *
 * Read by the Accounts module to explain why an account is not allocatable. No
 * permission check beyond being signed in: visibility is global, and an account
 * screen that hid the reason it was blocked would be worse than useless.
 */
async function activeForAccount(accountId: string): Promise<Result<readonly IssueRow[]>> {
  return problemsRepository.activeForAccount(accountId);
}

/**
 * Accounts that currently have a blocking problem, with the types of those
 * problems. One query for a whole page.
 */
async function accountsWithActiveProblems(
  accountIds: readonly string[],
): Promise<Result<ReadonlyMap<string, readonly IssueRow["issueType"][]>>> {
  return problemsRepository.accountsWithActiveProblems(accountIds);
}

/** Active problems touching a customer, through the profiles they hold. */
async function activeForCustomer(
  customerId: string,
  actor: AppUser | null,
): Promise<Result<readonly ProblemListEntry[]>> {
  const permitted = requirePermission(actor, PERMISSIONS.VIEW_PROBLEMS, "view problems");

  if (!permitted.ok) {
    return permitted;
  }

  return problemsRepository.activeForCustomer(customerId);
}

export const problemsService = {
  list,
  getDetail,
  report,
  update,
  remove,
  activeForAccount,
  accountsWithActiveProblems,
  activeForCustomer,
} as const;
