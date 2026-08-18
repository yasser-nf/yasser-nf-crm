"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import { UnauthorizedError, isAppError, type AppError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import { quickPrepareService } from "../services/quick-prepare.service";
import { quickReplaceService } from "../services/quick-replace.service";

/**
 * Quick Prepare server actions.
 *
 * ADR-006 Decision 3: the network boundary. Session check, audit context, one
 * service call, no business logic.
 *
 * Confirmation and replacement both return decrypted credentials. That is the
 * entire point of the flow, and it is why both are POST actions rather than
 * cached reads — a credential must never sit in a route cache.
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
    return toFailure(new UnauthorizedError("Quick Prepare action called without a session"));
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

/**
 * Read-only. Shows what would be allocated, taking nothing.
 *
 * Takes the whole request as one opaque input rather than positional arguments.
 * The previous signature was `(profileCount: number)` and silently dropped the
 * duration, so the preview stopped filtering by account validity and could
 * offer stock that `confirmPreparationAction` then refused. The service now
 * validates both fields, so an incomplete call fails loudly.
 */
export async function previewAllocationAction(input: unknown) {
  return run(async () => quickPrepareService.preview(input));
}

/** Allocates and returns credentials. Revalidates the screens whose data moved. */
export async function confirmPreparationAction(input: unknown) {
  return run(
    async (context) => quickPrepareService.confirm(input, context),
    [ROUTES.ACCOUNTS, ROUTES.QUICK_PREPARE],
  );
}

/**
 * Quick Replace, step one: look up a customer's allocation by account email.
 *
 * Read-only and revalidates nothing — it writes nothing at all. The whole point
 * of the preview/commit split is that an operator sees the full picture before
 * any allocation is released, so this must stay free of side effects.
 */
export async function previewReplacementAction(input: unknown) {
  return run(async () => quickReplaceService.preview(input));
}

/**
 * Quick Replace, step two: commit a replacement the operator confirmed.
 *
 * The ONLY action in the application that commits a replacement.
 *
 * `replaceAllocationAction` used to sit beside it and commit directly, with no
 * bound replacement account and no password-change gate. A Server Action is a
 * POST endpoint anybody holding a session can call, so "the UI always previews
 * first" was never a guarantee — the endpoint itself had to stop existing. It
 * was deleted rather than deprecated, along with its hook and service function.
 *
 * This one verifies the preview is still current, binds the commit to the
 * approved replacement account, enforces the password-change confirmation
 * against the LOCKED account, and refuses an already-expired allocation — the
 * M13 §10 guards.
 */
export async function confirmReplacementAction(input: unknown) {
  return run(
    async (context) => quickPrepareService.confirmReplacement(input, context),
    [ROUTES.ACCOUNTS, ROUTES.QUICK_PREPARE],
  );
}
