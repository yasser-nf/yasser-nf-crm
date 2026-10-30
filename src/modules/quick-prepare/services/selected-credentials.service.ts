import "server-only";

import { PERMISSIONS, roleHasPermission, type Permission } from "@/config/roles";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { accountsService } from "@/modules/accounts";
import type { AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import {
  revealPreparationCredentialsSchema,
  revealReplacementCredentialsSchema,
} from "../validation/quick-prepare.schema";
import { quickPrepareService } from "./quick-prepare.service";
import { quickReplaceService } from "./quick-replace.service";

/**
 * Credentials of the account an operator is about to confirm (M09D).
 *
 * WHAT HAS TO BE TRUE BEFORE A PASSWORD LEAVES THE SERVER
 *
 *   1. The caller may run this workflow — PREPARE_SUBSCRIPTIONS or
 *      REPLACE_ACCOUNTS. Checked here, because the workflow's own actions
 *      check only the session.
 *   2. The caller may read credentials at all — VIEW_ACCOUNTS, enforced by
 *      `accountsService.revealPassword`, the one function that decrypts a
 *      single account's password. Holding (1) does not imply (2).
 *   3. The account is the one the workflow currently has selected, and it is
 *      still eligible. The server keeps no workflow state, so this is proved
 *      the stateless way: the selection the page sends is re-evaluated by the
 *      same pinned preview M09C uses, under the same eligibility rules. An
 *      account that has since been sold, broken or run short of validity — or
 *      that the page never actually showed — is refused before anything is
 *      decrypted.
 *
 * The email returned is the one the SERVER resolved, never the browser's, so
 * the pair handed back always belongs to one account.
 *
 * WHAT THIS IS NOT
 *
 * Not a confidentiality boundary on its own: the account page's existing
 * reveal lets the same permission read any live account. What (3) adds is
 * integrity — the review step can only ever show the credentials of the
 * account it is about to sell or hand over.
 *
 * The plaintext is returned and nothing else touches it: not a log, not an
 * error, not an audit snapshot. `revealPassword` audits the read as
 * `password_revealed` with a `reason`, and no secret.
 */

export interface SelectedCredentials {
  readonly accountId: string;
  readonly email: string;
  readonly password: string;
}

const STALE_SELECTION_MESSAGE =
  "This account is no longer the one selected for this order. Ask for a new suggestion.";

function requireWorkflowPermission(
  context: AuditContext,
  permission: Permission,
  workflow: string,
): Result<true> {
  const actor = context.actor;

  if (!actor) {
    return fail(new ForbiddenError(`No signed-in user for ${workflow} credentials`));
  }

  if (!roleHasPermission(actor.role, permission)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not use ${workflow}`, {
        userMessage: "You do not have permission to view these credentials.",
      }),
    );
  }

  return ok(true);
}

/** A refusal that names no account and quotes no input. */
function invalidRequest(): ValidationError {
  return new ValidationError("Credential request failed validation", {
    userMessage: "That credential request was not valid. Reload the page and try again.",
  });
}

async function forPreparation(
  input: unknown,
  context: AuditContext,
): Promise<Result<SelectedCredentials>> {
  const permitted = requireWorkflowPermission(
    context,
    PERMISSIONS.PREPARE_SUBSCRIPTIONS,
    "Quick Prepare",
  );

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = revealPreparationCredentialsSchema.safeParse(input);

  if (!parsed.success) {
    return fail(invalidRequest());
  }

  const { profileCount, durationDays, accountIds, accountId } = parsed.data;

  /*
   * The selection, re-evaluated. Pinned to the reviewed accounts, so this is
   * the same answer the page would get on "Use this" — including a refusal if
   * any of them can no longer carry the order.
   */
  const current = await quickPrepareService.preview({ profileCount, durationDays, accountIds });

  if (!current.ok) {
    return fail(
      new ValidationError("Selection no longer valid for a credential read", {
        userMessage: STALE_SELECTION_MESSAGE,
      }),
    );
  }

  const selected = current.value.accounts.find((account) => account.accountId === accountId);

  if (!selected) {
    return fail(
      new ValidationError("Requested account is not in the current plan", {
        userMessage: STALE_SELECTION_MESSAGE,
      }),
    );
  }

  const password = await accountsService.revealPassword(accountId, context, "quick_prepare");

  if (!password.ok) {
    return password;
  }

  return ok({ accountId, email: selected.email, password: password.value });
}

async function forReplacement(
  input: unknown,
  context: AuditContext,
): Promise<Result<SelectedCredentials>> {
  const permitted = requireWorkflowPermission(
    context,
    PERMISSIONS.REPLACE_ACCOUNTS,
    "Quick Replace",
  );

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = revealReplacementCredentialsSchema.safeParse(input);

  if (!parsed.success) {
    return fail(invalidRequest());
  }

  const { accountEmail, customerId, replacementAccountId } = parsed.data;

  /* The proposal, re-derived: same failing account, same customer, pinned replacement. */
  const current = await quickReplaceService.preview({
    accountEmail,
    customerId,
    replacementAccountId,
  });

  if (!current.ok) {
    return fail(
      new ValidationError("Replacement lookup failed for a credential read", {
        userMessage: STALE_SELECTION_MESSAGE,
      }),
    );
  }

  const replacement = current.value.replacement;

  /*
   * Only the proposed replacement, for exactly this customer. The failing
   * account can never match: the lookup excludes it from every proposal.
   */
  if (
    current.value.blockedReason !== null ||
    current.value.selected?.customer.id !== customerId ||
    replacement?.account.id !== replacementAccountId
  ) {
    return fail(
      new ValidationError("Replacement is not the current proposal", {
        userMessage: STALE_SELECTION_MESSAGE,
      }),
    );
  }

  const password = await accountsService.revealPassword(
    replacementAccountId,
    context,
    "quick_replace",
  );

  if (!password.ok) {
    return password;
  }

  return ok({
    accountId: replacementAccountId,
    email: replacement.account.email,
    password: password.value,
  });
}

export const selectedCredentialsService = { forPreparation, forReplacement } as const;
