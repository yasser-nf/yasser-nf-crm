"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import { UnauthorizedError, isAppError, type AppError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import { suppliersService } from "../services/suppliers.service";

/**
 * Supplier Server Actions (M09B).
 *
 * Each one hands straight to the service, which checks the permission before
 * it reads anything — these add a session and flatten the Result, nothing more.
 */

export type SupplierActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly message: string;
      readonly code: string;
      readonly fieldErrors?: Record<string, string>;
    };

function toFailure(error: AppError): SupplierActionResult<never> {
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
): Promise<SupplierActionResult<T>> {
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
    return isAppError(caught)
      ? toFailure(caught)
      : { ok: false, message: "Something went wrong. Please try again.", code: "UNEXPECTED_ERROR" };
  }
}

export async function createSupplierAction(input: unknown) {
  return run(async (context) => suppliersService.create(input, context), [ROUTES.SUPPLIERS]);
}

export async function updateSupplierAction(id: unknown, input: unknown) {
  return run(
    async (context) => suppliersService.update(typeof id === "string" ? id : "", input, context),
    [ROUTES.SUPPLIERS],
  );
}

export async function deleteSupplierAction(id: unknown) {
  return run(
    async (context) => suppliersService.remove(typeof id === "string" ? id : "", context),
    [ROUTES.SUPPLIERS],
  );
}

export async function assignSupplierAction(input: unknown) {
  return run(
    async (context) => suppliersService.assign(input, context),
    [ROUTES.SUPPLIERS, ROUTES.ACCOUNTS],
  );
}
