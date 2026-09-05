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
import { logger } from "@/lib/logger";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { LoginHistoryRow, UserRow } from "@/lib/drizzle/schema";
import {
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  ValidationError,
  type AppError,
} from "@/lib/errors";
import { auditService, type AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { activityRepository, type ActivityEntry } from "../repositories/activity.repository";
import { derivePresence, type PresenceState } from "./presence";
import { sessionsRepository, type SessionRow } from "../repositories/sessions.repository";
import { usersRepository, type UserFilter } from "../repositories/users.repository";
import { changeRoleSchema, changeStatusSchema, inviteUserSchema } from "../validation/user.schema";
import {
  deriveInvitationState,
  mayResendInvitation,
  type InvitationState,
} from "./invitation-status";

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
  /**
   * Derived from Supabase's timestamps, never stored.
   *
   * Distinct from `user.status`, which is the operational state an
   * administrator sets. A person can be `active` and still not have accepted
   * their invitation — that is precisely the case the Resend action exists for.
   */
  readonly invitation: InvitationState;
  /** When the most recent invitation was sent. Null if they were never invited. */
  readonly invitedAt: Date | null;
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
    items: page.value.items.map(({ user, invitedAt, acceptedAt }) => {
      const lastActiveAt = lastActivity.get(user.id) ?? null;

      return {
        user,
        lastActiveAt,
        presence: derivePresence(lastActiveAt, now),
        /* Same clock as presence, so one row cannot straddle the boundary. */
        invitation: deriveInvitationState({ invitedAt, acceptedAt }, now),
        invitedAt,
      };
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
    .map(({ user, invitedAt, acceptedAt }) => {
      const lastActiveAt = activity.value.get(user.id) ?? null;

      return {
        user,
        lastActiveAt,
        presence: derivePresence(lastActiveAt, now),
        invitation: deriveInvitationState({ invitedAt, acceptedAt }, now),
        invitedAt,
      };
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

/**
 * Sends a fresh invitation to somebody who never accepted their last one.
 *
 * NOT a second invitation implementation. It calls the same
 * `inviteUserByEmail` with the same `absoluteUrl(ROUTES.AUTH_CALLBACK)` that
 * `invite` uses, so a resent link enters the identical flow — Supabase, then
 * /auth/callback, then /auth/set-password, then the dashboard. What it does NOT
 * do is anything `invite` does around that call: no schema parse, no email
 * uniqueness check, and above all no `usersRepository.create`, because the
 * public.users row already exists and creating a second one is the failure mode
 * this method has to avoid.
 *
 * Supabase reissues against the existing auth identity — the same user id, a new
 * token — so the previous link stops being the one to use. The auth user is
 * never recreated either.
 *
 * The six steps the brief asks for, in order: authenticate (the action supplies
 * a context, and a null actor is refused by requirePermission), authorize,
 * load the target, verify eligibility, send, audit.
 */
/**
 * What the operator is told when Supabase refuses, and why each differs.
 *
 * Exported so a test asserts the exact wording rather than a paraphrase, and so
 * the button can title its toast by outcome.
 */
export const RESEND_FAILURE = {
  RATE_LIMITED:
    "Too many invitation emails have been sent recently. Please wait a few minutes and try again.",
  ALREADY_REGISTERED:
    "That address is already registered in Supabase, so no new invitation can be sent to it.",
  INVALID_ADDRESS:
    "Supabase rejected that email address. Check it is spelled correctly and can receive mail.",
  UNKNOWN: "The invitation could not be sent. Try again in a moment.",
} as const;

/**
 * Maps Supabase's refusal onto one of our errors.
 *
 * Keyed on `error_code` — Supabase's stable machine-readable field — and NOT on
 * substrings of the human message, which change without notice and would fall
 * silently through to the generic case when they do. HTTP status is a fallback
 * for responses that carry no code.
 *
 * All three were observed against the live project rather than guessed at:
 *
 *   over_email_send_rate_limit  429  the built-in SMTP allows only a few
 *                                    messages an hour. Waiting is the only
 *                                    remedy, so the message says so; retrying
 *                                    immediately makes it worse.
 *   email_exists                422  Supabase refuses to invite an identity it
 *                                    already holds. Our own eligibility check
 *                                    normally stops this case first.
 *   email_address_invalid       400  Supabase would not accept the address.
 *
 * The error CLASS differs per case deliberately: `code` survives the RSC
 * boundary, so the browser can title these differently without parsing English.
 */
function resendFailureError(
  error: { message?: string; code?: string; status?: number } | null,
): AppError {
  const code = error?.code ?? "";
  const status = error?.status;
  const detail = `Supabase invitation resend failed: ${error?.message ?? "no user returned"}`;

  if (code === "over_email_send_rate_limit" || status === 429) {
    return new ExternalServiceError(detail, {
      cause: error,
      userMessage: RESEND_FAILURE.RATE_LIMITED,
    });
  }

  if (code === "email_exists" || status === 422) {
    return new ConflictError(detail, {
      cause: error,
      userMessage: RESEND_FAILURE.ALREADY_REGISTERED,
    });
  }

  if (code === "email_address_invalid") {
    return new ValidationError(detail, {
      cause: error,
      userMessage: RESEND_FAILURE.INVALID_ADDRESS,
    });
  }

  return new ExternalServiceError(detail, { cause: error, userMessage: RESEND_FAILURE.UNKNOWN });
}

async function resendInvite(id: string, context: AuditContext): Promise<Result<UserRow>> {
  /*
   * Same permission as sending the first invitation. A resend puts a working
   * credential-setting link into somebody's inbox, so it is exactly as
   * privileged as inviting them, and must not be reachable by a worker who
   * happens to know the Server Action's name.
   */
  const permitted = requirePermission(
    context.actor,
    PERMISSIONS.MANAGE_USERS,
    "resend invitations",
  );

  if (!permitted.ok) {
    return permitted;
  }

  const existing = await usersRepository.findById(id);

  if (!existing.ok) {
    /* Already a NotFoundError from the repository. */
    return existing;
  }

  const target = existing.value;

  /*
   * Eligibility is re-derived HERE, from Supabase, rather than trusted from the
   * client. The button being hidden is a courtesy; this is the check.
   */
  const invitation = await usersRepository.invitationTimestamps(id);

  if (!invitation.ok) {
    return invitation;
  }

  const state = deriveInvitationState(invitation.value);

  if (!mayResendInvitation(state)) {
    return fail(
      new ConflictError(`Invitation resend refused for accepted user ${id}`, {
        userMessage:
          "That person has already accepted their invitation and does not need a new one.",
      }),
    );
  }

  const admin = createSupabaseAdminClient();

  if (!admin.ok) {
    return admin;
  }

  /*
   * The stored email, never one supplied by the caller. The action takes an id
   * and nothing else, so there is no parameter through which an invitation
   * could be redirected to a different mailbox.
   */
  const invited = await admin.value.auth.admin.inviteUserByEmail(target.email, {
    redirectTo: absoluteUrl(ROUTES.AUTH_CALLBACK),
  });

  if (invited.error || !invited.data.user) {
    /*
     * Logged, because otherwise a failed invitation tells an operator nothing.
     * The generic message the UI shows is deliberate — Supabase's wording can
     * name internals — but somebody has to be able to find out WHY, and the
     * error's own text is the only place that knows.
     *
     * Safe to record: this is a refusal reason, not a credential. No token, no
     * link and no session goes near it.
     */
    logger.error("Supabase refused an invitation resend", invited.error, {
      userId: target.id,
      status: invited.error?.status,
      code: invited.error?.code,
    });

    /*
     * Nothing has been written at this point and nothing will be: no audit
     * entry, no auth event, and no timestamp anywhere. A refused send leaves
     * the invitation exactly as it was, which is what stops the UI claiming a
     * resend that never happened.
     */
    return fail(resendFailureError(invited.error));
  }

  /*
   * Recorded as an update to the user, carrying what happened rather than a
   * changed field — nothing on the row changes, and `audit_action` has no
   * value for this. Adding one would mean a migration for a label.
   *
   * No token, no link and no session detail: the entry says an invitation was
   * resent, by whom, to which user, and when. That is the whole of what an
   * audit reader needs and the whole of what is safe to keep.
   */
  await auditService.recordOrWarn(
    {
      entity: "user",
      entityId: target.id,
      action: "update",
      before: { invitationState: state },
      after: { invitationState: "pending", event: "invitation_resent" },
    },
    context,
  );

  /*
   * The same auth event `invite` records. A resend IS an invitation being sent,
   * so it belongs in the same series rather than a new event type — the user's
   * timeline then reads as the sequence of invitations it actually was.
   */
  await activityRepository.recordAuthEvent({
    userId: target.id,
    email: target.email,
    eventType: "invitation_sent",
    ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}),
  });

  return ok(target);
}

export const usersService = {
  list,
  onlineNow,
  getDetail,
  invite,
  resendInvite,
  changeRole,
  changeStatus,
  archive,
} as const;
