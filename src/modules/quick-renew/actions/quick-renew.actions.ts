"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import { UnauthorizedError, ValidationError, isAppError, type AppError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import { quickRenewService } from "../services/quick-renew.service";
import { renewalOperationIdSchema } from "../validation/renewal.schema";

/**
 * Quick Renewing's Server Actions (M09A).
 *
 * The same shape every other module's actions use: a Result from the service,
 * flattened to a plain object the client can hold, with the error's safe
 * `userMessage` and nothing else.
 */

export type RenewActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly message: string;
      readonly code: string;
      readonly fieldErrors?: Record<string, string>;
    };

function toFailure(error: AppError): RenewActionResult<never> {
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
): Promise<RenewActionResult<T>> {
  const context = await requireContext();

  if (!context) {
    return toFailure(new UnauthorizedError("Quick Renewing called without a session"));
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
    return isAppError(caught)
      ? toFailure(caught)
      : { ok: false, message: "Something went wrong. Please try again.", code: "UNEXPECTED_ERROR" };
  }
}

export async function searchRenewAccountsAction(input: unknown) {
  return run(async (context) => quickRenewService.searchAccounts(input, context.actor));
}

export async function listRenewProfilesAction(accountId: unknown) {
  return run(async (context) =>
    quickRenewService.listProfiles(typeof accountId === "string" ? accountId : "", context.actor),
  );
}

export async function previewRenewalAction(input: unknown) {
  return run(async (context) => quickRenewService.preview(input, context.actor));
}

/**
 * M09A: a confirmation from the browser must carry its operation id.
 *
 * The service accepts a call without one (server callers get a fresh key per
 * call), but a browser request without one could not be told apart from its own
 * repeat — so it is refused here, before any work, rather than allowed to renew
 * twice. A page loaded before this change sends none; reloading fixes it.
 */
export async function confirmRenewalAction(input: unknown) {
  if (!renewalOperationIdSchema.safeParse(input).success) {
    return toFailure(
      new ValidationError("Renewal confirmed without an operation id", {
        userMessage: "This page is out of date. Reload it and try again.",
      }),
    );
  }

  return run(
    async (context) => quickRenewService.confirm(input, context),
    [ROUTES.ACCOUNTS, ROUTES.QUICK_RENEW, ROUTES.CUSTOMERS],
  );
}
