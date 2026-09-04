import "server-only";

import {
  PERMISSIONS,
  USER_ROLES,
  USER_STATUSES,
  roleHasPermission,
  type UserRole,
  type UserStatus,
} from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import type { Page } from "@/lib/database";
import { absoluteUrl } from "@/config/app-url";
import { ROUTES } from "@/config/constants";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { LoginHistoryRow, UserRow } from "@/lib/drizzle/schema";
import { ConflictError, ExternalServiceError, ForbiddenError, ValidationError } from "@/lib/errors";
import { auditService, type AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { activityRepository, type ActivityEntry } from "../repositories/activity.repository";
import { derivePresence, type PresenceState } from "./presence";
import { sessionsRepository, type SessionRow } from "../repositories/sessions.repository";
import { usersRepository, type UserFilter } from "../repositories/users.repository";
import { changeRoleSchema, changeStatusSchema, inviteUserSchema } from "../validation/user.schema";

/**
 * Users service.
 *
 * The security centre of the application. Every authorization decision about
 * people lives here — never in a component, never in an action. A Server Action
 * is a POST endpoint anyone holding a session can call directly, so hiding a
 * button is presentation, not protection.
 */

export interface UserListEntry {
  readonly user: UserRow;
  readonly presence: PresenceState;
  readonly lastActiveAt: Date | null;
}

export interface UserDetail {
  readonly user: UserRow;
  readonly presence: PresenceState;
  readonly lastActiveAt: Date | null;
  readonly sessions: readonly SessionRow[];
  readonly activity: readonly ActivityEntry[];
  readonly loginHistory: readonly LoginHistoryRow[];
  readonly permissions: readonly string[];
}

/** Gate for every administrative operation in this module. */
function requirePermission(
  actor: AppUser | null,
  permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS],
  action: string,
): Result<AppUser> {
  if (!actor) {
    return fail(new ForbiddenError(`No signed-in user for ${action}`));
  }

  if (!roleHasPermission(actor.role, permission)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not ${action}`, {
        userMessage: "You do not have permission to do that.",
        context: { actorId: actor.id, role: actor.role, permission },
      }),
    );
  }

  return ok(actor);
}

/**
 * Lists users with presence.
 *
 * Two queries total: the page, and one grouped read of session activity. Asking
 * per row would be the N+1 the brief forbids.
 */
async function list(
  filter: UserFilter,
  actor: AppUser | null,
): Promise<Result<Page<UserListEntry>>> {
  const permitted = requirePermission(actor, PERMISSIONS.MANAGE_USERS, "view users");

  if (!permitted.ok) {
    return permitted;
  }

  const page = await usersRepository.list(filter);

  if (!page.ok) {
    return page;
  }

  const activity = await sessionsRepository.lastActivityByUser();
  const now = new Date();

  /*
   * Presence degrades rather than fails. If the session read breaks, everyone
   * shows offline and the list still renders — a users screen that cannot load
   * because a presence indicator failed would be worse than an inaccurate dot.
   */
  const lastActivity = activity.ok ? activity.value : new Map<string, Date>();

  return ok({
    ...page.value,
    items: page.value.items.map((user) => {
      const lastActiveAt = lastActivity.get(user.id) ?? null;
      return { user, lastActiveAt, presence: derivePresence(lastActiveAt, now) };
    }),
  });
}

/**
 * Who is working right now.
 *
 * Unfiltered and unpaginated on purpose — it answers "who is around", which the
 * filtered list cannot, because a search for "amina" would hide everyone else.
 * Reading every user is acceptable at this scale: this is an internal CRM whose
 * user table is measured in tens, not millions. It becomes a real query the day
 * that stops being true.
 */
async function onlineNow(actor: AppUser | null): Promise<Result<readonly UserListEntry[]>> {
  const permitted = requirePermission(actor, PERMISSIONS.MANAGE_USERS, "view who is online");

  if (!permitted.ok) {
    return permitted;
  }

  const page = await usersRepository.list({ status: USER_STATUSES.ACTIVE, limit: 200, offset: 0 });

  if (!page.ok) {
    return page;
  }

  const activity = await sessionsRepository.lastActivityByUser();

  if (!activity.ok) {
    /* Same degradation as list(): unknown activity means nobody is shown, not an error page. */
    return ok([]);
  }

  const now = new Date();

  const present = page.value.items
    .map((user) => {
      const lastActiveAt = activity.value.get(user.id) ?? null;
      return { user, lastActiveAt, presence: derivePresence(lastActiveAt, now) };
    })
    .filter((entry) => entry.presence !== "offline")
    .sort((a, b) => (b.lastActiveAt?.getTime() ?? 0) - (a.lastActiveAt?.getTime() ?? 0));

  return ok(present);
}

async function getDetail(id: string, actor: AppUser | null): Promise<Result<UserDetail>> {
  const permitted = requirePermission(actor, PERMISSIONS.MANAGE_USERS, "view a user");

  if (!permitted.ok) {
    return permitted;
  }

  const user = await usersRepository.findById(id);

  if (!user.ok) {
    return user;
  }

  const [sessions, activity, history] = await Promise.all([
    sessionsRepository.listForUser(id),
    activityRepository.activityForUser(id),
    activityRepository.loginHistoryForUser(id, { limit: 25 }),
  ]);

  const liveSessions = sessions.ok ? sessions.value : [];
  const lastActiveAt = liveSessions[0]?.lastActiveAt ?? null;

  return ok({
    user: user.value,
    lastActiveAt,
    presence: derivePresence(lastActiveAt, new Date()),
    sessions: liveSessions,
    activity: activity.ok ? activity.value : [],
    loginHistory: history.ok ? history.value.items : [],
    permissions: [],
  });
}

/**
 * Invites someone to the CRM.
 *
 * ADR-008 Decision 3: this is the only way a user is created. No password is
 * ever accepted, generated, or stored by the CRM — Supabase emails an invite,
 * the person sets their own password, and the public.users row is written here
 * so authorization exists the moment they first sign in.
 *
 * The CRM row is created immediately rather than on first login. Without it,
 * getCurrentUser would reject the new person as an identity with no CRM record,
 * and their first sign-in would silently fail.
 */
async function invite(input: unknown, context: AuditContext): Promise<Result<UserRow>> {
  const permitted = requirePermission(context.actor, PERMISSIONS.MANAGE_USERS, "invite users");

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = inviteUserSchema.safeParse(input);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};

    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && !(field in fieldErrors)) {
        fieldErrors[field] = issue.message;
      }
    }

    return fail(new ValidationError("Invitation input failed validation", { fieldErrors }));
  }

  const { email, name, role } = parsed.data;

  const existing = await usersRepository.findByEmail(email);

  if (existing.ok) {
    return fail(
      new ConflictError(`User already exists: ${email}`, {
        userMessage: "Someone with that email address is already a user.",
      }),
    );
  }

  const admin = createSupabaseAdminClient();

  if (!admin.ok) {
    return admin;
  }

  /*
   * Supabase sends the invitation and creates the auth identity. The returned
   * id becomes the public.users primary key, per ADR-005 Decision 3 — one
   * identity, nothing to synchronise.
   */
  /*
   * inviteUserByEmail, never createUser.
   *
   * createUser requires a password, which would mean the CRM choosing or
   * handling one — forbidden by ADR-008 Decision 2. The invite path has
   * Supabase email a link and the person set their own password, so no password
   * ever passes through this codebase.
   */
  /*
   * redirectTo is not optional in practice.
   *
   * Without it Supabase sends the invited person to the project's dashboard
   * Site URL, which was `http://localhost:3000` — a server on THEIR machine,
   * not ours. Every invitation ended on a browser error page. Naming the
   * callback here makes the application, not a dashboard field somebody set
   * during setup, the authority on where its own invitations land.
   *
   * The destination must also be listed under Supabase's Redirect URLs, which
   * is what stops this parameter being an open redirect.
   */
  const invited = await admin.value.auth.admin.inviteUserByEmail(email, {
    redirectTo: absoluteUrl(ROUTES.AUTH_CALLBACK),
  });

  if (invited.error || !invited.data.user) {
    return fail(
      new ExternalServiceError(
        `Supabase invitation failed: ${invited.error?.message ?? "no user"}`,
        {
          cause: invited.error,
          userMessage: "The invitation could not be sent. Check the email address and try again.",
        },
      ),
    );
  }

  const created = await usersRepository.create({
    id: invited.data.user.id,
    name,
    email,
    role,
    status: USER_STATUSES.ACTIVE,
  });

  if (!created.ok) {
    /*
     * The auth identity now exists without a CRM record. Deliberately not
     * rolled back: deleting an auth user is destructive, and the recoverable
     * state is a pending invite that can be re-sent. The failure is surfaced so
     * it is not silent.
     */
    return created;
  }

  await auditService.recordOrWarn(
    { entity: "user", entityId: created.value.id, action: "create", after: created.value },
    context,
  );

  await activityRepository.recordAuthEvent({
    userId: created.value.id,
    email,
    eventType: "invitation_sent",
    ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}),
  });

  return created;
}

/**
 * Changes a role.
 *
 * Two rules beyond the permission check. Neither can be enforced by the
 * database, because both depend on the state of other rows.
 */
async function changeRole(
  id: string,
  input: unknown,
  context: AuditContext,
): Promise<Result<UserRow>> {
  const permitted = requirePermission(
    context.actor,
    PERMISSIONS.MODIFY_PERMISSIONS,
    "change roles",
  );

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = changeRoleSchema.safeParse(input);

  if (!parsed.success) {
    return fail(new ValidationError("Role is not valid"));
  }

  const role: UserRole = parsed.data.role;

  /*
   * Nobody edits their own role. A Super Admin demoting themselves by accident
   * locks the door from the inside, and self-promotion is the escalation this
   * check exists to prevent.
   */
  if (context.actor && context.actor.id === id) {
    return fail(
      new ForbiddenError("Self role change refused", {
        userMessage: "You cannot change your own role. Ask another Super Admin.",
      }),
    );
  }

  const guard = await guardLastSuperAdmin(id, role !== USER_ROLES.SUPER_ADMIN);

  if (!guard.ok) {
    return guard;
  }

  const before = await usersRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  const updated = await usersRepository.setRole(id, role);

  if (!updated.ok) {
    return updated;
  }

  await auditService.recordOrWarn(
    {
      entity: "user",
      entityId: id,
      action: "update",
      before: before.value,
      after: updated.value,
    },
    context,
  );

  return updated;
}

/**
 * Suspends, disables, or reactivates a user.
 *
 * The difference between the two denial states is what happens to sessions:
 * suspended leaves them, disabled revokes them immediately. Both refuse
 * authentication, because getCurrentUser requires `active`.
 */
async function changeStatus(
  id: string,
  input: unknown,
  context: AuditContext,
): Promise<Result<UserRow>> {
  const permitted = requirePermission(
    context.actor,
    PERMISSIONS.MANAGE_USERS,
    "change user status",
  );

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = changeStatusSchema.safeParse(input);

  if (!parsed.success) {
    return fail(new ValidationError("Status is not valid"));
  }

  const status: UserStatus = parsed.data.status;

  if (context.actor && context.actor.id === id && status !== USER_STATUSES.ACTIVE) {
    return fail(
      new ForbiddenError("Self lockout refused", {
        userMessage: "You cannot suspend or disable your own account.",
      }),
    );
  }

  const guard = await guardLastSuperAdmin(id, status !== USER_STATUSES.ACTIVE);

  if (!guard.ok) {
    return guard;
  }

  const before = await usersRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  const updated = await usersRepository.setStatus(id, status);

  if (!updated.ok) {
    return updated;
  }

  /*
   * Disabling revokes every session immediately — the brief's rule. Suspension
   * deliberately does not, so lifting it restores access without a new sign-in.
   */
  if (status === USER_STATUSES.DISABLED) {
    const revoked = await sessionsRepository.revokeAllForUser(id);

    if (revoked.ok && revoked.value > 0) {
      await activityRepository.recordAuthEvent({
        userId: id,
        email: updated.value.email,
        eventType: "session_revoked",
        failureReason: "account disabled",
      });
    }
  }

  await auditService.recordOrWarn(
    { entity: "user", entityId: id, action: "update", before: before.value, after: updated.value },
    context,
  );

  return updated;
}

/**
 * Archives a user.
 *
 * The brief forbids deletion outright, so there is no delete method anywhere in
 * this module. Archiving soft-deletes, disables, and revokes every session.
 */
async function archive(id: string, context: AuditContext): Promise<Result<UserRow>> {
  const permitted = requirePermission(context.actor, PERMISSIONS.MANAGE_USERS, "archive users");

  if (!permitted.ok) {
    return permitted;
  }

  if (context.actor && context.actor.id === id) {
    return fail(
      new ForbiddenError("Self archive refused", {
        userMessage: "You cannot archive your own account.",
      }),
    );
  }

  const guard = await guardLastSuperAdmin(id, true);

  if (!guard.ok) {
    return guard;
  }

  const before = await usersRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  const archived = await usersRepository.softDelete(id);

  if (!archived.ok) {
    return archived;
  }

  await sessionsRepository.revokeAllForUser(id);

  await auditService.recordOrWarn(
    { entity: "user", entityId: id, action: "delete", before: before.value, after: archived.value },
    context,
  );

  return archived;
}

/**
 * Refuses a change that would remove the last usable Super Admin.
 *
 * Not expressible as a database constraint: it depends on a count across other
 * rows at the moment of the change. Without it, demoting or disabling the wrong
 * account locks everybody out of user management permanently, with no way back
 * through the application.
 */
async function guardLastSuperAdmin(
  targetId: string,
  wouldRemoveAccess: boolean,
): Promise<Result<true>> {
  if (!wouldRemoveAccess) {
    return ok(true);
  }

  const target = await usersRepository.findById(targetId);

  if (!target.ok) {
    return target;
  }

  if (target.value.role !== USER_ROLES.SUPER_ADMIN || target.value.status !== "active") {
    return ok(true);
  }

  const remaining = await usersRepository.countActiveSuperAdmins(targetId);

  if (!remaining.ok) {
    return remaining;
  }

  if (remaining.value === 0) {
    return fail(
      new ForbiddenError("Refused: this is the last active Super Admin", {
        userMessage:
          "This is the only active Super Admin. Promote someone else before changing this account.",
      }),
    );
  }

  return ok(true);
}

export const usersService = {
  list,
  onlineNow,
  getDetail,
  invite,
  changeRole,
  changeStatus,
  archive,
} as const;
