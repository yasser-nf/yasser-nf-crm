"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import { UnauthorizedError, isAppError, type AppError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import { suppliersService } from "../services/suppliers.service";

/**
 * Supplier server actions. M10.
 *
 * ADR-006 Decision 3: the network boundary. Session check, audit context, one
 * service call, no business logic.
 *
 * Authorization is NOT here. `suppliersService` checks VIEW_SUPPLIERS or
 * MANAGE_SUPPLIERS on every entry point, and `accountsService` applies the
 * same assignment permission — because the service is the boundary every
 * caller crosses, and a second entry point added later must not be able to
 * skip it. This layer only establishes who is asking.
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
    return toFailure(new UnauthorizedError("Supplier action called without a session"));
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
    /* M10 §26: no SQL text, no stack trace — only `AppError.userMessage` leaves. */
    return isAppError(caught)
      ? toFailure(caught)
      : { ok: false, message: "Something went wrong. Please try again.", code: "UNEXPECTED_ERROR" };
  }
}

/**
 * Where a supplier change is visible: the supplier list, the accounts list
 * (its Supplier column and filter) and the dashboard (ownership and the
 * per-supplier table).
 */
const SUPPLIER_SURFACES = [ROUTES.SUPPLIERS, ROUTES.ACCOUNTS, ROUTES.DASHBOARD] as const;

export async function createSupplierAction(input: unknown) {
  return run(async (context) => suppliersService.createSupplier(input, context), SUPPLIER_SURFACES);
}

export async function updateSupplierAction(id: string, input: unknown) {
  return run(
    async (context) => suppliersService.updateSupplier(id, input, context),
    SUPPLIER_SURFACES,
  );
}

/** Deactivate or reactivate. Accounts already assigned are untouched (§23). */
export async function setSupplierActiveAction(id: string, active: boolean) {
  return run(
    async (context) => suppliersService.setSupplierActive(id, active, context),
    SUPPLIER_SURFACES,
  );
}
