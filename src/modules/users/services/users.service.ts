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
import { configurationService } from "@/modules/settings";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { activityRepository, type ActivityEntry } from "../repositories/activity.repository";
import { derivePresence, type PresenceState } from "./presence";
import { sessionsRepository, type SessionRow } from "../repositories/sessions.repository";
import { usersRepository, type UserFilter } from "../repositories/users.repository";
import { buildCreateUserSchema } from "../validation/create-user.schema";
import { changeRoleSchema, changeStatusSchema } from "../validation/user.schema";
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
 * The roles an actor may give somebody when creating them.
 *
 * Read off the existing matrix, not a new hierarchy. Creating a user at all is
 * MANAGE_USERS; giving someone Super Admin is granting every permission there
 * is, which the matrix already reserves for MODIFY_PERMISSIONS — the same
 * permission `changeRole` requires. Today both belong to Super Admin alone, so
 * a Super Admin may assign either role and nobody else may create anyone.
 *
 * Exported so the form lists exactly what the service will accept.
 */
export function assignableRoles(actorRole: UserRole): readonly UserRole[] {
  if (!roleHasPermission(actorRole, PERMISSIONS.MANAGE_USERS)) {
    return [];
  }

  return roleHasPermission(actorRole, PERMISSIONS.MODIFY_PERMISSIONS)
    ? [USER_ROLES.WORKER, USER_ROLES.SUPER_ADMIN]
    : [USER_ROLES.WORKER];
}

/**
 * What the operator is told when a user cannot be created.
 *
 * Exported so tests assert the exact wording rather than a paraphrase.
 */
export const CREATE_FAILURE = {
  EMAIL_TAKEN: "That email address is already registered. Each user needs their own address.",
  WEAK_PASSWORD: "Supabase rejected that password as too weak. Choose a longer or less common one.",
  INVALID_ADDRESS:
    "Supabase rejected that email address. Check it is spelled correctly and can receive mail.",
  UNKNOWN: "The user could not be created. Try again in a moment.",
  PROFILE_FAILED: "The user could not be created. Nothing was saved; try again in a moment.",
  ROLLBACK_FAILED:
    "The user could not be created, and the sign-in account Supabase made could not be removed. Ask a developer to check Supabase Auth before retrying this address.",
} as const;

/**
 * Removes every occurrence of the password from a piece of text.
 *
 * Defence in depth. Nothing in this module puts the password into a message,
 * but Supabase's wording is not ours: if it ever quoted the input back, this is
 * what keeps that out of a log line or an error the browser receives.
 */
function withoutPassword(text: string, password: string): string {
  return password.length > 0 ? text.split(password).join("[redacted]") : text;
}

interface SafeAuthFailure {
  readonly code: string;
  readonly status: number | undefined;
  readonly message: string;
}

/**
 * The part of a Supabase error that is safe to carry onwards.
 *
 * The error object itself is never kept as a `cause`: `toLogObject` stringifies
 * causes, and a third-party object is not ours to trust. Code and status are
 * machine values; the message is scrubbed of the password first.
 */
function safeAuthFailure(
  error: { message?: string; code?: string; status?: number } | null,
  password: string,
): SafeAuthFailure {
  return {
    code: error?.code ?? "",
    status: error?.status,
    message: withoutPassword(error?.message ?? "no user returned", password),
  };
}

/**
 * Maps Supabase's refusal onto one of our errors.
 *
 * Keyed on `error_code`, as `resendFailureError` is, with HTTP status as the
 * fallback for responses that carry no code.
 */
function createFailureError(failure: SafeAuthFailure): AppError {
  const detail = `Supabase user creation failed: ${failure.code || String(failure.status ?? "unknown")} ${failure.message}`;
  const context = { code: failure.code, status: failure.status };

  if (
    failure.code === "email_exists" ||
    failure.code === "user_already_exists" ||
    (failure.code === "" && failure.status === 422)
  ) {
    return new ConflictError(detail, {
      context,
      userMessage: CREATE_FAILURE.EMAIL_TAKEN,
    });
  }

  if (failure.code === "weak_password") {
    return new ValidationError(detail, {
      context,
      userMessage: CREATE_FAILURE.WEAK_PASSWORD,
      fieldErrors: { password: CREATE_FAILURE.WEAK_PASSWORD },
    });
  }

  if (failure.code === "email_address_invalid") {
    return new ValidationError(detail, {
      context,
      userMessage: CREATE_FAILURE.INVALID_ADDRESS,
      fieldErrors: { email: CREATE_FAILURE.INVALID_ADDRESS },
    });
  }

  return new ExternalServiceError(detail, { context, userMessage: CREATE_FAILURE.UNKNOWN });
}

/**
 * Creates a user directly, with a password the administrator chooses.
 *
 * ADR-014 replaces ADR-008 Decisions 2 and 3: an administrator types the
 * person's password and they can sign in immediately. The password passes
 * through this function exactly once — from the validated input to Supabase
 * Auth, which hashes and stores it — and goes nowhere else: not into
 * public.users, not into the audit entry, not into a log line, not into the
 * value returned to the browser.
 *
 * Two writes in two systems, which cannot share a transaction: the auth identity
 * in Supabase, then the public.users row that authorizes it. The order is fixed
 * by the foreign key from public.users.id to auth.users.id. If the second write
 * fails, the first is undone — the identity this call just created, named by
 * the id Supabase returned for it, and nothing else. An existing user is never
 * touched on any failure path: a duplicate address is refused before anything
 * is written, and Supabase refusing the address means it created nothing to
 * undo.
 */
async function create(input: unknown, context: AuditContext): Promise<Result<UserRow>> {
  const permitted = requirePermission(context.actor, PERMISSIONS.MANAGE_USERS, "create users");

  if (!permitted.ok) {
    return permitted;
  }

  const actor = permitted.value;

  /* The stored policy, never one the caller supplies. */
  const security = await configurationService.security();
  const parsed = buildCreateUserSchema(security.passwordMinLength).safeParse(input);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};

    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && !(field in fieldErrors)) {
        fieldErrors[field] = issue.message;
      }
    }

    /* Field names and rule messages only. The input itself is not attached. */
    return fail(new ValidationError("User creation input failed validation", { fieldErrors }));
  }

  const { email, name, password, role } = parsed.data;

  /*
   * Server-side, whatever the form offered. A request naming a role the actor
   * may not grant is refused here, before Supabase is asked for anything.
   */
  if (!assignableRoles(actor.role).includes(role)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not assign role ${role}`, {
        userMessage: "You do not have permission to assign that role.",
        context: { actorId: actor.id, role: actor.role, requestedRole: role },
      }),
    );
  }

  const existing = await usersRepository.findByEmail(email);

  if (existing.ok) {
    return fail(
      new ConflictError(`User already exists: ${email}`, {
        userMessage: CREATE_FAILURE.EMAIL_TAKEN,
      }),
    );
  }

  const admin = createSupabaseAdminClient();

  if (!admin.ok) {
    return admin;
  }

  /*
   * `email_confirm: true` is what makes the account usable at once. Without it
   * Supabase holds the identity unconfirmed and refuses the first sign-in until
   * somebody follows an email link — the invitation flow this replaces.
   *
   * No role, name or anything else goes into Supabase's metadata. public.users
   * is the authority on role (ADR-005 Decision 3), and a second copy in a
   * user-editable metadata field is a second answer that could disagree.
   */
  const created = await admin.value.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (created.error || !created.data.user) {
    const failure = safeAuthFailure(created.error, password);

    /*
     * Machine fields only. Supabase's message goes into the returned error,
     * already scrubbed, and never into the log line.
     */
    logger.error("Supabase refused to create a user", undefined, {
      code: failure.code,
      status: failure.status,
    });

    return fail(createFailureError(failure));
  }

  const authUserId = created.data.user.id;

  let profile: Result<UserRow>;

  try {
    profile = await usersRepository.create({
      id: authUserId,
      name,
      email,
      role,
      status: USER_STATUSES.ACTIVE,
    });
  } catch {
    /* Caught so compensation still runs; the thrown value is not carried. */
    profile = fail(new ExternalServiceError("public.users insert threw"));
  }

  if (!profile.ok) {
    /*
     * Compensation. The identity was created by THIS call a moment ago and has
     * never been used, so removing it loses nothing and prevents an auth user
     * with no CRM record — one getCurrentUser would refuse forever, holding an
     * address nobody could reuse.
     */
    const rollback = await admin.value.auth.admin.deleteUser(authUserId);

    if (rollback.error) {
      logger.error("User creation left an orphaned auth identity", undefined, {
        authUserId,
        code: rollback.error.code,
        status: rollback.error.status,
        profileError: profile.error.code,
      });

      return fail(
        new ExternalServiceError("Compensating deleteUser failed after profile insert failed", {
          context: { authUserId, profileError: profile.error.code },
          userMessage: CREATE_FAILURE.ROLLBACK_FAILED,
        }),
      );
    }

    logger.warn("User creation rolled back: public.users insert failed", {
      authUserId,
      profileError: profile.error.code,
    });

    return fail(
      new ExternalServiceError("public.users insert failed; auth identity removed", {
        context: { profileError: profile.error.code },
        userMessage: CREATE_FAILURE.PROFILE_FAILED,
      }),
    );
  }

  /*
   * The row as stored — it has no password column — plus what happened. The
   * audit sanitizer's allow-list and deep redaction apply on top, so even a
   * mistake here could not write a credential.
   */
  await auditService.recordOrWarn(
    {
      entity: "user",
      entityId: profile.value.id,
      action: "create",
      after: { ...profile.value, event: "user_created" },
    },
    context,
  );

  return profile;
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
 * Kept for people invited before ADR-014 — new users are created directly with
 * a password and are never in this state. It calls `inviteUserByEmail` with
 * `absoluteUrl(ROUTES.AUTH_CALLBACK)`, so a resent link enters the same flow the
 * original invitation did — Supabase, then /auth/callback, then
 * /auth/set-password, then the dashboard. There is no schema parse, no email
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
   * Same permission as creating a user. A resend puts a working
   * credential-setting link into somebody's inbox, so it is exactly as
   * privileged as creating them, and must not be reachable by a worker who
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
   * The same auth event the original invitation recorded. A resend IS an
   * invitation being sent, so it belongs in the same series rather than a new
   * event type — the user's timeline then reads as the sequence of invitations
   * it actually was.
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
  create,
  resendInvite,
  changeRole,
  changeStatus,
  archive,
} as const;
