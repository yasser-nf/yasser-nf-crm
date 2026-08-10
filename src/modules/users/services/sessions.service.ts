import "server-only";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import { auditService } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { activityRepository } from "../repositories/activity.repository";
import { sessionsRepository, type SessionRow } from "../repositories/sessions.repository";
import { usersRepository } from "../repositories/users.repository";

/**
 * Sessions service.
 *
 * Supabase Auth owns sessions; this reads and revokes them. No second session
 * table exists, per the M06 brief.
 *
 * Revocation deletes the session row, which prevents any further refresh. The
 * already-issued access token stays valid until it expires — at most an hour —
 * because a JWT cannot be recalled once signed. That is a property of the token
 * format, not a gap in this code, and it is why disabling a user also sets a
 * status that getCurrentUser rejects on the very next request.
 */

function requireManageUsers(actor: AppUser | null, action: string): Result<AppUser> {
  if (!actor) {
    return fail(new ForbiddenError(`No signed-in user for ${action}`));
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.MANAGE_USERS)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not ${action}`, {
        userMessage: "You do not have permission to manage sessions.",
        context: { actorId: actor.id, role: actor.role },
      }),
    );
  }

  return ok(actor);
}

async function listForUser(
  userId: string,
  actor: AppUser | null,
): Promise<Result<readonly SessionRow[]>> {
  /*
   * A person may always see their own sessions. Reviewing where you are signed
   * in is a basic security affordance, not an administrative privilege.
   */
  if (actor?.id !== userId) {
    const permitted = requireManageUsers(actor, "view another user's sessions");

    if (!permitted.ok) {
      return permitted;
    }
  }

  return sessionsRepository.listForUser(userId);
}

/** Ends one session. */
async function revoke(
  sessionId: string,
  ownerId: string,
  context: AuditContext,
): Promise<Result<number>> {
  if (context.actor?.id !== ownerId) {
    const permitted = requireManageUsers(context.actor, "revoke another user's session");

    if (!permitted.ok) {
      return permitted;
    }
  }

  /*
   * Confirm the session belongs to the stated owner before deleting. Without
   * this, a caller could pass any session id with their own user id and end
   * somebody else's session while passing the ownership check.
   */
  const sessions = await sessionsRepository.listForUser(ownerId);

  if (!sessions.ok) {
    return sessions;
  }

  if (!sessions.value.some((session) => session.id === sessionId)) {
    return fail(
      new NotFoundError("Session does not belong to that user", {
        userMessage: "That session no longer exists.",
      }),
    );
  }

  const revoked = await sessionsRepository.revoke(sessionId);

  if (!revoked.ok) {
    return revoked;
  }

  const owner = await usersRepository.findById(ownerId);

  await activityRepository.recordAuthEvent({
    userId: ownerId,
    email: owner.ok ? owner.value.email : undefined,
    eventType: "session_revoked",
    ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}),
  });

  await auditService.recordOrWarn(
    {
      entity: "user",
      entityId: ownerId,
      action: "update",
      after: { event: "session_revoked", sessionId },
    },
    context,
  );

  return revoked;
}

/** Ends every session for a user. */
async function revokeAll(userId: string, context: AuditContext): Promise<Result<number>> {
  if (context.actor?.id !== userId) {
    const permitted = requireManageUsers(context.actor, "revoke another user's sessions");

    if (!permitted.ok) {
      return permitted;
    }
  }

  const revoked = await sessionsRepository.revokeAllForUser(userId);

  if (!revoked.ok) {
    return revoked;
  }

  const owner = await usersRepository.findById(userId);

  await activityRepository.recordAuthEvent({
    userId,
    email: owner.ok ? owner.value.email : undefined,
    eventType: "session_revoked",
    failureReason: "all sessions revoked",
    ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}),
  });

  await auditService.recordOrWarn(
    {
      entity: "user",
      entityId: userId,
      action: "update",
      after: { event: "all_sessions_revoked", count: revoked.value },
    },
    context,
  );

  return ok(revoked.value);
}

export const sessionsService = { listForUser, revoke, revokeAll } as const;
