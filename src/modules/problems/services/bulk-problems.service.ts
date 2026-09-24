import "server-only";

import { ForbiddenError, ValidationError } from "@/lib/errors";
import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import { PAGINATION } from "@/config/constants";
import type { AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { runForEach, uniqueIds, type BulkOutcome } from "@/utils/bulk";
import { problemsService } from "./problems.service";
import { problemResolutionService } from "./problem-resolution.service";
import { problemAssignmentService } from "./problem-assignment.service";
import { isBlocking } from "./problem-lifecycle";
import { problemsRepository } from "../repositories/problems.repository";

/**
 * Declaring and resolving problems across many accounts at once.
 *
 * This lives in the problems module because the M08 brief is explicit that no
 * other module may create or resolve problems directly. The accounts list is
 * only where the operator happens to be standing; the rule about what a problem
 * is still belongs here.
 *
 * Nothing below decides anything. `report` and `resolve` are called exactly as
 * a single-account screen calls them, so every problem still gets its own
 * validation, its own transition check, its own permission check and its own
 * audit entry. In particular a Worker still may only resolve problems assigned
 * to them — `assertMayMutate` runs per problem, and selecting ten accounts does
 * not change that.
 *
 * The only thing added here is the loop and the report.
 */

/**
 * Maximum accounts one bulk problem operation may touch.
 *
 * Selection cannot reach past one page of 25, so this is not a limit an
 * operator can meet through the UI. It exists because a Server Action is a POST
 * endpoint anyone signed in can call directly with a hand-written array.
 */
const MAX_BULK_ACCOUNTS = PAGINATION.MAX_PAGE_SIZE;

function readAccountIds(accountIds: unknown): Result<string[]> {
  if (!Array.isArray(accountIds) || accountIds.some((id) => typeof id !== "string")) {
    return fail(
      new ValidationError("Bulk problem operation received something other than a list of ids", {
        userMessage: "Select at least one account first.",
      }),
    );
  }

  const requested = uniqueIds(accountIds as string[]);

  if (requested.length === 0) {
    return fail(
      new ValidationError("Bulk problem operation received no ids", {
        userMessage: "Select at least one account first.",
      }),
    );
  }

  if (requested.length > MAX_BULK_ACCOUNTS) {
    return fail(
      new ValidationError(`Bulk problem operation received ${requested.length} ids`, {
        userMessage: `You can act on at most ${MAX_BULK_ACCOUNTS} accounts at a time.`,
      }),
    );
  }

  return ok(requested);
}

/**
 * Declares the same problem against each selected account.
 *
 * One problem per account, each created through `problemsService.report`, so
 * the description and severity are validated once per row by the same schema a
 * single report uses — and each account's health consequence and audit entry
 * happen exactly as they would one at a time.
 *
 * The account id is injected here rather than taken from the input, so a
 * caller cannot smuggle a different account into the payload than the one it
 * selected.
 */
async function declareForAccounts(
  accountIds: unknown,
  input: unknown,
  context: AuditContext,
): Promise<Result<BulkOutcome>> {
  const requested = readAccountIds(accountIds);

  if (!requested.ok) {
    return requested;
  }

  const details = typeof input === "object" && input !== null ? input : {};

  const outcome = await runForEach(requested.value, (accountId) =>
    problemsService.report({ ...details, accountId }, context),
  );

  return ok(outcome);
}

/**
 * Resolves every open problem on each selected account.
 *
 * An account can carry more than one open problem, and the operator selected
 * the account rather than a problem — so "resolve this account" has to mean all
 * of them, or the badge would still say Problem afterwards and the action would
 * look broken.
 *
 * If any one of an account's problems is refused, the account is reported as
 * failed and carries that refusal's message. The ones that did resolve stay
 * resolved: they are independent records, and undoing them would need a second
 * write that is itself a lie about what happened.
 */
async function resolveForAccounts(
  accountIds: unknown,
  input: unknown,
  context: AuditContext,
): Promise<Result<BulkOutcome>> {
  const requested = readAccountIds(accountIds);

  if (!requested.ok) {
    return requested;
  }

  const outcome = await runForEach(requested.value, async (accountId) => {
    const open = await problemsService.activeForAccount(accountId);

    if (!open.ok) {
      return open;
    }

    if (open.value.length === 0) {
      /*
       * Not an error worth failing the batch over in principle, but it is
       * reported: an account the operator believed had a problem and does not
       * is something they should see rather than have silently counted as done.
       */
      return fail(
        new ValidationError(`Account ${accountId} has no open problem`, {
          userMessage: "This account has no open problem to resolve.",
        }),
      );
    }

    for (const problem of open.value) {
      const resolved = await problemResolutionService.resolve(problem.id, input, context);

      if (!resolved.ok) {
        return resolved;
      }
    }

    return ok(true);
  });

  return ok(outcome);
}

/* ------------------------------------------------------------------------- */
/* Problem-level bulk actions — the Problems page toolbar (M03).              */
/* ------------------------------------------------------------------------- */

/**
 * What a problem-level bulk action did, problem by problem.
 *
 * `skipped` is not a failure: it is a problem the action did not apply to —
 * already resolved or closed, for Resolve — left exactly as it was. Reported
 * separately so "3 resolved, 1 skipped" never reads as "1 failed".
 */
export interface ProblemBulkOutcome {
  readonly succeeded: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  readonly failed: readonly { readonly id: string; readonly message: string }[];
}

/** A page of problem ids, validated the same way as a page of account ids. */
function readProblemIds(ids: unknown): Result<string[]> {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return fail(
      new ValidationError("Bulk problem action received something other than a list of ids", {
        userMessage: "Select at least one problem first.",
      }),
    );
  }

  const requested = uniqueIds(ids as string[]);

  if (requested.length === 0) {
    return fail(
      new ValidationError("Bulk problem action received no ids", {
        userMessage: "Select at least one problem first.",
      }),
    );
  }

  if (requested.length > MAX_BULK_ACCOUNTS) {
    return fail(
      new ValidationError(`Bulk problem action received ${requested.length} ids`, {
        userMessage: `You can act on at most ${MAX_BULK_ACCOUNTS} problems at a time.`,
      }),
    );
  }

  return ok(requested);
}

/**
 * Resolves each selected problem through `problemResolutionService.resolve`.
 *
 * Every problem is re-read now, not trusted from the page the operator saw:
 *
 *   - gone since it was selected           -> failed, "no longer exists"
 *   - no longer blocking (resolved, closed,
 *     cancelled)                           -> skipped, left exactly as it is;
 *                                             never reopened or re-resolved
 *   - blocking                             -> resolved by the existing service,
 *                                             which applies the ownership rule,
 *                                             the transition graph and the
 *                                             required resolution note, and
 *                                             writes the usual audit entry
 *
 * One problem at a time, each in its own write, like every other bulk action
 * here: the existing resolution is per problem, and a refusal on one (a Worker
 * resolving somebody else's) must not undo the others. Every outcome is
 * reported. Resolving never touches `accounts.status`; an account whose last
 * blocking problem this was becomes operational again by derivation.
 */
async function resolveProblems(
  ids: unknown,
  input: unknown,
  context: AuditContext,
): Promise<Result<ProblemBulkOutcome>> {
  if (!context.actor) {
    return fail(new ForbiddenError("No signed-in user to resolve problems"));
  }

  const requested = readProblemIds(ids);

  if (!requested.ok) {
    return requested;
  }

  const succeeded: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const failed: { id: string; message: string }[] = [];

  for (const id of requested.value) {
    const current = await problemsRepository.findById(id);

    if (!current.ok) {
      failed.push({ id, message: "This problem no longer exists." });
      continue;
    }

    if (!isBlocking(current.value.status)) {
      skipped.push({ id, reason: `Already ${current.value.status.replace(/_/g, " ")}.` });
      continue;
    }

    const resolved = await problemResolutionService.resolve(id, input, context);

    if (resolved.ok) {
      succeeded.push(id);
    } else {
      failed.push({ id, message: resolved.error.userMessage });
    }
  }

  return ok({ succeeded, skipped, failed });
}

/**
 * Assigns each selected problem to one person, through
 * `problemAssignmentService.assign` — its permission rule (a Super Admin may
 * assign anyone; a Worker may only claim an unassigned problem for themselves
 * or release their own), its refusal of closed and cancelled problems, and its
 * audit entry. A problem already assigned to that person is reported as skipped.
 */
async function assignProblems(
  ids: unknown,
  input: unknown,
  context: AuditContext,
): Promise<Result<ProblemBulkOutcome>> {
  if (!context.actor) {
    return fail(new ForbiddenError("No signed-in user to assign problems"));
  }

  const requested = readProblemIds(ids);

  if (!requested.ok) {
    return requested;
  }

  const target =
    typeof input === "object" && input !== null && "assignedTo" in input
      ? (input as { assignedTo: unknown }).assignedTo
      : undefined;

  const succeeded: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const failed: { id: string; message: string }[] = [];

  for (const id of requested.value) {
    const current = await problemsRepository.findById(id);

    if (!current.ok) {
      failed.push({ id, message: "This problem no longer exists." });
      continue;
    }

    if (current.value.assignedTo === target) {
      skipped.push({ id, reason: "Already assigned to that person." });
      continue;
    }

    const assigned = await problemAssignmentService.assign(id, input, context);

    if (assigned.ok) {
      succeeded.push(id);
    } else {
      failed.push({ id, message: assigned.error.userMessage });
    }
  }

  return ok({ succeeded, skipped, failed });
}

/**
 * Deletes each selected problem through `problemsService.remove`.
 *
 * MANAGE_PROBLEMS (Super Admin) is checked once up front so a Worker gets one
 * clear refusal rather than a list of every problem refused; `remove` checks it
 * again for each. Deleting a problem removes that problem row and its own
 * problem notes (a database cascade) and nothing else: the account, its
 * profiles and its customers are untouched. Each deletion is audited.
 */
async function deleteProblems(
  ids: unknown,
  context: AuditContext,
): Promise<Result<ProblemBulkOutcome>> {
  const actor = context.actor;

  if (!actor || !roleHasPermission(actor.role, PERMISSIONS.MANAGE_PROBLEMS)) {
    return fail(
      new ForbiddenError("Bulk problem delete refused", {
        userMessage: "Only a Super Admin can delete problems.",
      }),
    );
  }

  const requested = readProblemIds(ids);

  if (!requested.ok) {
    return requested;
  }

  const outcome = await runForEach(requested.value, (id) => problemsService.remove(id, context));

  return ok({ succeeded: outcome.succeeded, skipped: [], failed: outcome.failed });
}

export const bulkProblemsService = {
  declareForAccounts,
  resolveForAccounts,
  resolveProblems,
  assignProblems,
  deleteProblems,
} as const;
