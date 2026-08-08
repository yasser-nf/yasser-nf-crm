"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import { UnauthorizedError, isAppError, type AppError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import { quickPrepareService } from "../services/quick-prepare.service";

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

/** Read-only. Shows what would be allocated, taking nothing. */
export async function previewAllocationAction(profileCount: number) {
  return run(async () => quickPrepareService.preview(profileCount));
}

/** Allocates and returns credentials. Revalidates the screens whose data moved. */
export async function confirmPreparationAction(input: unknown) {
  return run(
    async (context) => quickPrepareService.confirm(input, context),
    [ROUTES.ACCOUNTS, ROUTES.QUICK_PREPARE],
  );
}

export async function replaceAllocationAction(input: unknown) {
  return run(
    async (context) => quickPrepareService.replaceAllocation(input, context),
    [ROUTES.ACCOUNTS, ROUTES.QUICK_PREPARE],
  );
}
