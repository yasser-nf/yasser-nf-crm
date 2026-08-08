"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import { UnauthorizedError, isAppError, type AppError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import type { AccountFilter } from "../repositories/accounts.repository";
import { accountsService } from "../services/accounts.service";
import { profilesService } from "../services/profiles.service";

/**
 * Account server actions.
 *
 * ADR-006 Decision 3: this is the network boundary. An action validates that
 * someone is signed in, builds the audit context, calls exactly one service
 * method, and returns. It contains no business logic.
 *
 * Every action returns a serialisable envelope rather than a Result. A Result
 * carries an AppError instance, and class instances do not survive the
 * server-to-client boundary — the prototype and its methods are lost, so
 * `error.userMessage` would be undefined by the time a component read it.
 */

/** Serialisable outcome. The client-side shape of a Result. */
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
    /* Only userMessage crosses the boundary. Never the technical message. */
    message: error.userMessage,
    code: error.code,
    ...(fieldErrors ? { fieldErrors } : {}),
  };
}

/**
 * Resolves the caller and request metadata.
 *
 * Middleware already rejects unauthenticated requests, but a Server Action is a
 * POST endpoint that can be invoked directly. 02_ARCHITECTURE.md requires
 * validating twice, so the session is checked again rather than assumed.
 */
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

/** Wraps an action body with authentication, error mapping and revalidation. */
async function run<T>(
  operation: (context: AuditContext) => Promise<ServiceOutcome<T>>,
  revalidate: readonly string[] = [],
): Promise<ActionResult<T>> {
  const context = await requireContext();

  if (!context) {
    return toFailure(new UnauthorizedError("Server action called without a session"));
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
     * A service returns a Result rather than throwing, but an action is the
     * outermost boundary and must not leak a stack trace to the browser if one
     * ever does.
     */
    return isAppError(caught)
      ? toFailure(caught)
      : { ok: false, message: "Something went wrong. Please try again.", code: "UNEXPECTED_ERROR" };
  }
}

export async function createAccountAction(input: unknown) {
  return run(async (context) => accountsService.createAccount(input, context), [ROUTES.ACCOUNTS]);
}

export async function updateAccountAction(id: string, input: unknown) {
  return run(
    async (context) => accountsService.updateAccount(id, input, context),
    [ROUTES.ACCOUNTS, `${ROUTES.ACCOUNTS}/${id}`],
  );
}

export async function archiveAccountAction(id: string) {
  return run(
    async (context) => accountsService.archiveAccount(id, context),
    [ROUTES.ACCOUNTS, `${ROUTES.ACCOUNTS}/${id}`],
  );
}

export async function restoreAccountAction(id: string) {
  return run(
    async (context) => accountsService.restoreAccount(id, context),
    [ROUTES.ACCOUNTS, `${ROUTES.ACCOUNTS}/${id}`],
  );
}

export async function deleteAccountAction(id: string) {
  return run(async (context) => accountsService.softDeleteAccount(id, context), [ROUTES.ACCOUNTS]);
}

/**
 * Returns the decrypted password.
 *
 * ADR-006 Decision 4: the only path by which plaintext reaches a browser, and
 * only in response to a deliberate click. The service audits every call.
 */
export async function revealAccountPasswordAction(id: string) {
  return run(async (context) => accountsService.revealPassword(id, context));
}

export async function updateProfileAction(accountId: string, profileId: string, input: unknown) {
  return run(
    async (context) => {
      const result = await profilesService.updateProfile(profileId, input, context);

      return result.ok ? { ok: true as const, value: result.value.profile } : result;
    },
    [`${ROUTES.ACCOUNTS}/${accountId}`],
  );
}

/** Paginated, filtered, sorted accounts list. Read-only, still session-gated. */
export async function listAccountsAction(filter: AccountFilter) {
  return run(async () => accountsService.listAccounts(filter));
}
