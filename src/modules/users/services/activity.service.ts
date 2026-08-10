import "server-only";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import type { Page, PaginationInput } from "@/lib/database";
import type { LoginHistoryRow } from "@/lib/drizzle/schema";
import { ForbiddenError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { activityRepository, type ActivityEntry } from "../repositories/activity.repository";
import type { LoginHistoryInsert } from "../validation/user.schema";

/**
 * Activity service.
 *
 * Two reads and one write.
 *
 * The Activity Feed stays separate from the Audit Log as the brief requires,
 * but separation is achieved by reading along a different axis rather than by
 * storing anything twice. Audit answers "what happened to this account";
 * activity answers "what did this person do". Duplicating the rows would double
 * every write and create two histories that can disagree.
 */

function requireCanView(
  actor: AppUser | null,
  targetUserId: string,
  action: string,
): Result<AppUser> {
  if (!actor) {
    return fail(new ForbiddenError(`No signed-in user for ${action}`));
  }

  /* Everyone may review their own history. */
  if (actor.id === targetUserId) {
    return ok(actor);
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.MANAGE_USERS)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not ${action}`, {
        userMessage: "You do not have permission to view that.",
        context: { actorId: actor.id, role: actor.role },
      }),
    );
  }

  return ok(actor);
}

async function feedForUser(
  userId: string,
  actor: AppUser | null,
  limit = 50,
): Promise<Result<readonly ActivityEntry[]>> {
  const permitted = requireCanView(actor, userId, "view another user's activity");

  if (!permitted.ok) {
    return permitted;
  }

  return activityRepository.activityForUser(userId, limit);
}

async function loginHistoryForUser(
  userId: string,
  actor: AppUser | null,
  pagination: PaginationInput = {},
): Promise<Result<Page<LoginHistoryRow>>> {
  const permitted = requireCanView(actor, userId, "view another user's login history");

  if (!permitted.ok) {
    return permitted;
  }

  return activityRepository.loginHistoryForUser(userId, pagination);
}

/**
 * Records an authentication event.
 *
 * Never fails the caller. A sign-in must not be refused because its history row
 * could not be written, and a failed sign-in is already a failure — turning a
 * logging problem into a second one helps nobody. Problems are logged loudly so
 * a broken security trail is visible in operations rather than silent.
 *
 * The caller decides what the event is. This function never infers success from
 * the absence of an error, so a failed attempt can never be recorded as a login.
 */
async function recordAuthEvent(input: LoginHistoryInsert): Promise<void> {
  const result = await activityRepository.recordAuthEvent(input);

  if (!result.ok) {
    logger.error("Auth event could not be recorded", result.error, {
      eventType: input.eventType,
    });
  }
}

export const activityService = { feedForUser, loginHistoryForUser, recordAuthEvent } as const;
