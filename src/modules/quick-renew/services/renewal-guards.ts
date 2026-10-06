import "server-only";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { allocationFitsAccount } from "@/modules/accounts";
import type { AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import type { RenewalBlockedReason } from "./renewal-eligibility";
import type { RenewalQuote } from "./renewal-duration";

/**
 * Quick Renew's guards: who may renew, and every way a renewal is refused.
 *
 * Separated from the two services so the lookup half and the commit half apply
 * the IDENTICAL check and produce the IDENTICAL wording. A refusal an operator
 * meets at confirmation must be the message the screen already showed them, and
 * two copies of the same sentence drift the first time one is reworded.
 */

/* ------------------------------------------------------------ authorization */

export function requireRenewer(context: AuditContext): Result<AppUser> {
  const actor = context.actor;

  if (!actor) {
    return fail(
      new ForbiddenError("No signed-in user for a renewal", {
        userMessage: "Sign in to renew a subscription.",
      }),
    );
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.RENEW_SUBSCRIPTIONS)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not renew a subscription`, {
        userMessage: "You do not have permission to renew subscriptions.",
        context: { actorId: actor.id, role: actor.role },
      }),
    );
  }

  return ok(actor);
}

/* ------------------------------------------------------------------- errors */

/** Field errors shaped so a refusal renders beside the input that caused it. */
export function toValidationError(
  issues: readonly { path: PropertyKey[]; message: string }[],
): ValidationError {
  const fieldErrors: Record<string, string> = {};

  for (const issue of issues) {
    /*
     * The duration is a nested union, so its issues arrive as ["duration",
     * "days"]. The form renders one error under the custom-days input, so the
     * LAST string segment is the useful key — "days", not "duration".
     */
    const segments = issue.path.filter((part): part is string => typeof part === "string");
    const field = segments[segments.length - 1];

    if (field !== undefined && !(field in fieldErrors)) {
      fieldErrors[field] = issue.message;
    }
  }

  return new ValidationError("Quick Renew input failed validation", { fieldErrors });
}

/**
 * The answer when the row no longer matches what the operator approved.
 *
 * A ConflictError rather than a validation failure: nothing the operator typed
 * was wrong, and the fix is to look it up again rather than to correct a field.
 */
export function movedOn(detail: string): ConflictError {
  return new ConflictError(`Renewal refused: ${detail}`, {
    userMessage:
      "This subscription changed while you were reviewing it — it may already have been " +
      "renewed. Look it up again before continuing.",
  });
}

/** The answer when a receipt exists but the renewal it names has moved on. */
export function staleReplay(): ConflictError {
  return new ConflictError("Replayed renewal no longer matches the live subscription", {
    userMessage:
      "This renewal was already completed, and the subscription has changed since. Look it up " +
      "again to see where it stands now.",
  });
}

/** The account's own coverage cannot carry the renewal. M13 §1, with the numbers. */
function beyondAccountValidity(validUntil: string, expirationDate: string): ValidationError {
  return new ValidationError(
    `Renewal to ${expirationDate} exceeds account validity ${validUntil}`,
    {
      userMessage:
        `This account is only valid until ${validUntil}, and the renewal would run to ` +
        `${expirationDate}. A subscription cannot outlive the account carrying it — choose a ` +
        `shorter renewal, or extend the account first.`,
      fieldErrors: { days: `Account valid until ${validUntil}` },
    },
  );
}

/**
 * Why a blocked profile cannot be renewed, in the operator's words.
 *
 * One wording per reason, produced on the server, so the refusal an operator
 * meets at confirmation is the message the screen already showed them.
 */
export function blockedRenewalMessage(reason: RenewalBlockedReason): string {
  switch (reason) {
    case "account_unavailable":
      return (
        "This account cannot serve anyone right now — it is not healthy, has an open problem, " +
        "or its own validity has run out. Use Quick Replace to move the customer onto a working " +
        "account instead."
      );
    case "slot_not_for_sale":
      return "This profile is not one of the account's sellable slots, so it cannot be renewed.";
    case "no_customer":
      return (
        "Nobody holds this profile, so there is no subscription to renew. Use Quick Prepare to " +
        "sell it."
      );
    case "customer_blocked":
      return "This customer is blocked. Unblock them before renewing their subscription.";
    case "customer_archived":
      return "This customer is archived. Restore them before renewing their subscription.";
  }
}

/**
 * The M13 §1 rule, applied to an absolute date.
 *
 * `allocationFitsAccount` is the same function the profile editor calls and the
 * same ruler Quick Prepare measures a duration with. Returns the refusal rather
 * than a boolean so the caller cannot forget to build one.
 *
 * The clock is an ARGUMENT, not a `new Date()` of its own. The caller has
 * already measured today to produce the quote, and a second reading could
 * straddle midnight — deciding the boundary rule against a different day than
 * the one the quote was built on.
 */
export function accountValidityRefusal(
  account: { readonly validUntil: string | null },
  computed: RenewalQuote,
  today: Date,
): ValidationError | null {
  if (allocationFitsAccount(account, computed.expirationDate, today)) {
    return null;
  }

  /* Unreachable with a null validUntil: an open-ended account fits anything. */
  return beyondAccountValidity(account.validUntil ?? "unknown", computed.expirationDate);
}
