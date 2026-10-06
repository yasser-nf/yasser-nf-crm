"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import { UnauthorizedError, ValidationError, isAppError, type AppError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import { quickRenewService } from "../services/quick-renew.service";
import { renewOperationIdSchema } from "../validation/quick-renew.schema";

/**
 * Quick Renew server actions. M09.
 *
 * ADR-006 Decision 3: the network boundary. Session check, audit context, one
 * service call, no business logic.
 *
 * Authorization is NOT here. `quickRenewService` checks RENEW_SUBSCRIPTIONS on
 * every entry point, including the read-only ones, because the service is the
 * boundary every caller crosses — a second entry point added later must not be
 * able to skip it. This layer only establishes who is asking.
 */

export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly message: string;
      readonly code: string;
      readonly fieldErrors?: Record<string, string>;
    };

function toFailure(error: AppError): ActionResult<never> {
  const fieldErrors =
    "fieldErrors" in error && error.fieldErrors ? { ...error.fieldErrors } : undefined;

  return {
    ok: false,
    message: error.userMessage,
    code: error.code,
    ...(fieldErrors ? { fieldErrors } : {}),
  };
}

async function requireContext(): Promise<AuditContext | null> {
  const actor = await getCurrentUser();

  if (!actor) {
    return null;
  }

  const headerList = await headers();

  return {
    actor,
    ipAddress: headerList.get("x-forwarded-for") ?? undefined,
    userAgent: headerList.get("user-agent") ?? undefined,
  };
}

type ServiceOutcome<T> = { ok: true; value: T } | { ok: false; error: AppError };

async function run<T>(
  operation: (context: AuditContext) => Promise<ServiceOutcome<T>>,
  revalidate: readonly string[] = [],
): Promise<ActionResult<T>> {
  const context = await requireContext();

  if (!context) {
    return toFailure(new UnauthorizedError("Quick Renew action called without a session"));
  }

  try {
    const result = await operation(context);

    if (!result.ok) {
      return toFailure(result.error);
    }

    for (const path of revalidate) {
      revalidatePath(path);
    }

    return { ok: true, data: result.value };
  } catch (caught) {
    /*
     * An unexpected throw becomes a generic message. M09 §18: no SQL text, no
     * stack trace and no secret reaches the browser — only `AppError.userMessage`
     * ever does.
     */
    return isAppError(caught)
      ? toFailure(caught)
      : { ok: false, message: "Something went wrong. Please try again.", code: "UNEXPECTED_ERROR" };
  }
}

/** Step one: find the account by email. Read-only, so it revalidates nothing. */
export async function previewRenewalAction(input: unknown) {
  return run(async (context) => quickRenewService.preview(input, context));
}

/** Step two: quote a renewal for one profile. Read-only. */
export async function quoteRenewalAction(input: unknown) {
  return run(async (context) => quickRenewService.quote(input, context));
}

/**
 * M08 jobs: a confirmation from the browser must carry its operation id.
 *
 * The service accepts a call without one (server code gets a fresh key per
 * call, which still protects the adapter's own transaction retries), but a
 * browser request without one could not be told apart from its own repeat — so
 * it is refused here, before any work, rather than allowed to renew twice. A
 * page loaded before this change sends none; reloading fixes it.
 */
function requireOperationId(input: unknown): ValidationError | null {
  return renewOperationIdSchema.safeParse(input).success
    ? null
    : new ValidationError("Renewal confirmation without an operation id", {
        userMessage: "This page is out of date. Reload it and try again.",
      });
}

/**
 * Step three: commit the renewal.
 *
 * Revalidates the screens whose data moved: the account's own page shows the
 * profile's new expiry, the accounts list shows its indicator, the customers
 * screens show the subscription, and the dashboard counts expiring allocations.
 */
export async function confirmRenewalAction(input: unknown) {
  const missing = requireOperationId(input);

  if (missing) {
    return toFailure(missing);
  }

  return run(
    async (context) => quickRenewService.confirm(input, context),
    [ROUTES.ACCOUNTS, ROUTES.CUSTOMERS, ROUTES.DASHBOARD, ROUTES.QUICK_RENEW],
  );
}
