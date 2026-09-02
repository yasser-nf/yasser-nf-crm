"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import { UnauthorizedError, isAppError, type AppError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import { customerExportService } from "../services/customer-export.service";
import { customersService } from "../services/customers.service";

/**
 * Customer server actions.
 *
 * ADR-006 Decision 3: the network boundary. Session check, audit context, one
 * service call, no business logic.
 *
 * Authorization is NOT performed here. The service owns it, so a future caller
 * that reaches the service another way cannot skip the check by not going
 * through an action.
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
    return toFailure(new UnauthorizedError("Customer action called without a session"));
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
 * Builds the customers CSV.
 *
 * Authorization is the service’s, by the same permission the customers page
 * requires. `params` is the page’s query string, re-parsed server-side.
 */
export async function exportCustomersAction(scope: unknown, params: unknown) {
  return run(async (context) =>
    customerExportService.exportCustomers(context.actor, scope, params),
  );
}

export async function updateCustomerNotesAction(id: string, notes: string) {
  return run(
    async (context) => customersService.updateNotes(id, notes, context),
    [`${ROUTES.CUSTOMERS}/${id}`],
  );
}

export async function setCustomerBlockedAction(id: string, blocked: boolean) {
  return run(
    async (context) => customersService.setBlocked(id, blocked, context),
    [ROUTES.CUSTOMERS, `${ROUTES.CUSTOMERS}/${id}`],
  );
}

export async function archiveCustomerAction(id: string) {
  return run(async (context) => customersService.archive(id, context), [ROUTES.CUSTOMERS]);
}
