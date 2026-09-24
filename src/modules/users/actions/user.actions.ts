"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import { UnauthorizedError, isAppError, type AppError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import { sessionsService } from "../services/sessions.service";
import { usersService } from "../services/users.service";

/**
 * User management server actions.
 *
 * ADR-006 Decision 3: the network boundary. Session check, audit context, one
 * service call.
 *
 * No authorization happens here — every check lives in the service. That is
 * deliberate: an action is only one route to a service, and putting the gate at
 * the door rather than on the safe means a second route bypasses it.
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
    return toFailure(new UnauthorizedError("User action called without a session"));
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
 * Creates a user with a password the administrator chose.
 *
 * The input carries that password, so this wrapper does nothing with it but
 * pass it on: no logging, no echo. What returns to the browser is the stored
 * public.users row, which has no password column — the password goes in and
 * never comes back out. Authorization, including which roles may be assigned,
 * is the service's.
 */
export async function createUserAction(input: unknown) {
  return run(async (context) => usersService.create(input, context), [ROUTES.USERS]);
}

/**
 * Sends a fresh invitation to somebody who never accepted theirs.
 *
 * Takes an id and nothing else. No email, no role, no redirect — every one of
 * those is resolved on the server from the stored row, so there is no parameter
 * a caller could use to point an invitation somewhere else. Authorization is the
 * service's, not this wrapper's: `run` refuses without a session, and
 * `resendInvite` refuses without MANAGE_USERS.
 */
export async function resendInviteAction(id: string) {
  return run(
    async (context) => usersService.resendInvite(id, context),
    [ROUTES.USERS, `${ROUTES.USERS}/${id}`],
  );
}

export async function changeUserRoleAction(id: string, role: string) {
  return run(
    async (context) => usersService.changeRole(id, { role }, context),
    [ROUTES.USERS, `${ROUTES.USERS}/${id}`],
  );
}

export async function changeUserStatusAction(id: string, status: string) {
  return run(
    async (context) => usersService.changeStatus(id, { status }, context),
    [ROUTES.USERS, `${ROUTES.USERS}/${id}`],
  );
}

export async function archiveUserAction(id: string) {
  return run(async (context) => usersService.archive(id, context), [ROUTES.USERS]);
}

export async function revokeSessionAction(sessionId: string, ownerId: string) {
  return run(
    async (context) => sessionsService.revoke(sessionId, ownerId, context),
    [`${ROUTES.USERS}/${ownerId}`],
  );
}

export async function revokeAllSessionsAction(userId: string) {
  return run(
    async (context) => sessionsService.revokeAll(userId, context),
    [ROUTES.USERS, `${ROUTES.USERS}/${userId}`],
  );
}
