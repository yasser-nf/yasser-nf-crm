import "server-only";

import { ValidationError } from "@/lib/errors";
import { PAGINATION } from "@/config/constants";
import type { AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { runForEach, uniqueIds, type BulkOutcome } from "@/utils/bulk";
import { problemsService } from "./problems.service";
import { problemResolutionService } from "./problem-resolution.service";

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

export const bulkProblemsService = { declareForAccounts, resolveForAccounts } as const;
