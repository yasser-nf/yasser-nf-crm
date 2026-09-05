import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  INVITE_LINK_LIFETIME_HOURS,
  deriveInvitationState,
  mayResendInvitation,
} from "@/modules/users/services/invitation-status";
import { RESEND_FAILURE } from "@/modules/users/services/users.service";
import { ok, fail } from "@/utils/result";
import { NotFoundError } from "@/lib/errors";

/**
 * Resending an invitation.
 *
 * Two things are being protected here.
 *
 * The first is that the CRM does not grow a second invitation-status system.
 * `public.users.status` is active|suspended|disabled and `invite()` writes
 * `active` immediately, so it has never described an invitation — the truth is
 * Supabase's `invited_at` and `email_confirmed_at`, and it is derived on read.
 *
 * The second is that a resend is exactly as privileged as an invite. It puts a
 * working credential-setting link into somebody's inbox, so the button being
 * hidden must not be what stops a worker, and the target's email must not be
 * something a caller can choose.
 */

const findById = vi.fn();
const invitationTimestamps = vi.fn();
const createUser = vi.fn();
const inviteUserByEmail = vi.fn();
const recordOrWarn = vi.fn();
const recordAuthEvent = vi.fn();

vi.mock("@/modules/users/repositories/users.repository", () => ({
  usersRepository: {
    findById: (id: string) => findById(id),
    invitationTimestamps: (id: string) => invitationTimestamps(id),
    create: (input: unknown) => createUser(input),
    findByEmail: () => fail(new NotFoundError("User not found")),
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () =>
    ok({
      auth: { admin: { inviteUserByEmail: (e: string, o: unknown) => inviteUserByEmail(e, o) } },
    }),
}));

vi.mock("@/modules/audit", () => ({
  auditService: { recordOrWarn: (i: unknown, c: unknown) => recordOrWarn(i, c) },
}));

vi.mock("@/modules/users/repositories/activity.repository", () => ({
  activityRepository: { recordAuthEvent: (i: unknown) => recordAuthEvent(i) },
}));

const { usersService } = await import("@/modules/users/services/users.service");

const SUPER_ADMIN = {
  id: "admin-1",
  email: "admin@example.com",
  displayName: "Admin",
  initials: "A",
  role: "super_admin" as const,
};

const WORKER = {
  ...SUPER_ADMIN,
  id: "worker-1",
  email: "worker@example.com",
  role: "worker" as const,
};

const TARGET = {
  id: "user-2",
  name: "Invited Person",
  email: "invited@example.com",
  role: "worker" as const,
  status: "active" as const,
  lastLoginAt: null,
  createdAt: new Date("2026-09-01"),
  updatedAt: new Date("2026-09-01"),
  deletedAt: null,
};

/** Invited two days ago and never accepted: expired. */
const EXPIRED = {
  invitedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
  acceptedAt: null,
};

beforeEach(() => {
  for (const m of [
    findById,
    invitationTimestamps,
    createUser,
    inviteUserByEmail,
    recordOrWarn,
    recordAuthEvent,
  ]) {
    m.mockReset();
  }

  findById.mockResolvedValue(ok(TARGET));
  invitationTimestamps.mockResolvedValue(ok(EXPIRED));
  inviteUserByEmail.mockResolvedValue({ data: { user: { id: TARGET.id } }, error: null });
  recordOrWarn.mockResolvedValue(undefined);
  recordAuthEvent.mockResolvedValue(ok({}));
});

describe("deriving the invitation state", () => {
  it("calls an accepted invitation accepted, however old", () => {
    /* The "do not mark a normal active user as expired" rule, at its source. */
    expect(
      deriveInvitationState({
        invitedAt: new Date("2020-01-01"),
        acceptedAt: new Date("2020-01-02"),
      }),
    ).toBe("accepted");
  });

  it("treats a user who was never invited as accepted, not pending", () => {
    /*
     * The original administrator, created directly rather than invited. There is
     * no outstanding invitation, so offering to resend one would be nonsense.
     */
    expect(deriveInvitationState({ invitedAt: null, acceptedAt: null })).toBe("accepted");
  });

  it("calls a fresh unaccepted invitation pending", () => {
    expect(
      deriveInvitationState({ invitedAt: new Date(Date.now() - 60 * 60 * 1000), acceptedAt: null }),
    ).toBe("pending");
  });

  it("calls an old unaccepted invitation expired", () => {
    expect(deriveInvitationState(EXPIRED)).toBe("expired");
  });

  it("switches at the configured lifetime, not at an invented number", () => {
    const justInside = new Date(Date.now() - (INVITE_LINK_LIFETIME_HOURS - 1) * 60 * 60 * 1000);
    const justOutside = new Date(Date.now() - (INVITE_LINK_LIFETIME_HOURS + 1) * 60 * 60 * 1000);

    expect(deriveInvitationState({ invitedAt: justInside, acceptedAt: null })).toBe("pending");
    expect(deriveInvitationState({ invitedAt: justOutside, acceptedAt: null })).toBe("expired");
  });

  it("offers a resend for both unaccepted states, and never for accepted", () => {
    expect(mayResendInvitation("expired")).toBe(true);
    expect(mayResendInvitation("pending")).toBe(true);
    expect(mayResendInvitation("accepted")).toBe(false);
  });
});

describe("authorization", () => {
  it("lets a Super Admin resend an expired invitation", async () => {
    const result = await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    expect(result.ok).toBe(true);
    expect(inviteUserByEmail).toHaveBeenCalledTimes(1);
  });

  it("refuses a worker, and sends nothing", async () => {
    const result = await usersService.resendInvite(TARGET.id, { actor: WORKER });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ForbiddenError");
    }

    /* The refusal happens BEFORE Supabase is touched, not after. */
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("refuses when there is no signed-in actor at all", async () => {
    const result = await usersService.resendInvite(TARGET.id, { actor: null });

    expect(result.ok).toBe(false);
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("checks permission before it even loads the target", async () => {
    /* An unauthorized caller must not be able to probe which ids exist. */
    await usersService.resendInvite(TARGET.id, { actor: WORKER });

    expect(findById).not.toHaveBeenCalled();
  });
});

describe("eligibility is decided on the server", () => {
  it("rejects an unknown user", async () => {
    findById.mockResolvedValue(fail(new NotFoundError("User not found")));

    const result = await usersService.resendInvite("missing", { actor: SUPER_ADMIN });

    expect(result.ok).toBe(false);
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("refuses somebody who already accepted", async () => {
    /*
     * The case the hidden button is only a courtesy about. A crafted call with a
     * valid admin session must still be refused here.
     */
    invitationTimestamps.mockResolvedValue(
      ok({ invitedAt: new Date("2026-09-01"), acceptedAt: new Date("2026-09-01") }),
    );

    const result = await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ConflictError");
    }

    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("re-reads the timestamps rather than trusting the page", async () => {
    await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    expect(invitationTimestamps).toHaveBeenCalledWith(TARGET.id);
  });

  it("allows a pending invitation to be resent", async () => {
    /* A link that never arrived leaves someone as stuck as an expired one. */
    invitationTimestamps.mockResolvedValue(
      ok({ invitedAt: new Date(Date.now() - 60 * 60 * 1000), acceptedAt: null }),
    );

    expect((await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN })).ok).toBe(true);
  });
});

describe("what is actually sent", () => {
  it("invites the stored email, not one supplied by the caller", async () => {
    await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    expect(inviteUserByEmail.mock.calls[0]?.[0]).toBe(TARGET.email);
  });

  it("uses the same production callback the first invitation uses", async () => {
    await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    const options = inviteUserByEmail.mock.calls[0]?.[1] as { redirectTo: string };

    expect(options.redirectTo.endsWith("/auth/callback")).toBe(true);
    /* Absolute — a relative redirect is unusable from an email client. */
    expect(() => new URL(options.redirectTo)).not.toThrow();
  });

  it("creates no second CRM user record", async () => {
    /*
     * The failure mode this method exists to avoid. `invite()` calls
     * usersRepository.create; a resend must not, because the row is already there.
     */
    await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    expect(createUser).not.toHaveBeenCalled();
  });

  it("returns the existing user unchanged", async () => {
    const result = await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    if (result.ok) {
      expect(result.value.id).toBe(TARGET.id);
      expect(result.value.email).toBe(TARGET.email);
    }
  });

  /*
   * The three codes below are the ones the LIVE project actually returned when
   * this failure was diagnosed, not invented examples:
   *
   *   over_email_send_rate_limit  429  what the reported failure turned out to be
   *   email_exists                422  returned for an already-confirmed account
   *   email_address_invalid       400  seen once, transiently, for the same address
   */
  it("names the rate limit, because waiting is the only remedy", async () => {
    inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: {
        message: "email rate limit exceeded",
        code: "over_email_send_rate_limit",
        status: 429,
      },
    });

    const result = await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.userMessage).toBe(RESEND_FAILURE.RATE_LIMITED);
    }
  });

  it("explains an already-registered address as a conflict", async () => {
    inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: {
        message: "A user with this email address has already been registered",
        code: "email_exists",
        status: 422,
      },
    });

    const result = await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    if (!result.ok) {
      expect(result.error.userMessage).toBe(RESEND_FAILURE.ALREADY_REGISTERED);
      /* A distinct class, so the browser can title it without parsing English. */
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  it("explains a rejected address", async () => {
    inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: {
        message: 'Email address "someone@example.com" is invalid',
        code: "email_address_invalid",
        status: 400,
      },
    });

    const result = await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    if (!result.ok) {
      expect(result.error.userMessage).toBe(RESEND_FAILURE.INVALID_ADDRESS);
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("keeps the generic wording for anything unrecognised", async () => {
    inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: { message: "connection reset at gotrue-internal:5432", code: "weird", status: 500 },
    });

    const result = await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    if (!result.ok) {
      expect(result.error.userMessage).toBe(RESEND_FAILURE.UNKNOWN);
    }
  });

  it("reads the code, not the wording", async () => {
    /*
     * Supabase's human messages change without notice. Keyed on the message,
     * this would fall through to the generic case and tell an operator to
     * "try again in a moment" while the rate limit kept refusing them.
     */
    inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: {
        message: "something entirely reworded by supabase",
        code: "over_email_send_rate_limit",
      },
    });

    const result = await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    if (!result.ok) {
      expect(result.error.userMessage).toBe(RESEND_FAILURE.RATE_LIMITED);
    }
  });

  it("falls back to HTTP status when there is no code", async () => {
    inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: { message: "too many requests", status: 429 },
    });

    const result = await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    if (!result.ok) {
      expect(result.error.userMessage).toBe(RESEND_FAILURE.RATE_LIMITED);
    }
  });

  it("never puts Supabase's internals in front of the operator", async () => {
    for (const error of [
      { message: "email rate limit exceeded", code: "over_email_send_rate_limit", status: 429 },
      { message: "already registered", code: "email_exists", status: 422 },
      { message: "connection reset at gotrue-internal:5432", code: "x", status: 500 },
    ]) {
      inviteUserByEmail.mockResolvedValue({ data: { user: null }, error });

      const result = await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

      if (!result.ok) {
        for (const leak of ["gotrue", "5432", "reset", "429"]) {
          expect(result.error.userMessage).not.toContain(leak);
        }
      }
    }
  });

  it("records nothing when the send failed", async () => {
    inviteUserByEmail.mockResolvedValue({ data: { user: null }, error: { message: "boom" } });

    await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    expect(recordOrWarn).not.toHaveBeenCalled();
    expect(recordAuthEvent).not.toHaveBeenCalled();
  });
});

describe("audit", () => {
  it("writes an audit entry naming the user and the actor's context", async () => {
    await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    const [entry, context] = recordOrWarn.mock.calls[0] as [
      { entity: string; entityId: string; after: Record<string, unknown> },
      { actor: { id: string } },
    ];

    expect(entry.entity).toBe("user");
    expect(entry.entityId).toBe(TARGET.id);
    expect(entry.after["event"]).toBe("invitation_resent");
    expect(context.actor.id).toBe(SUPER_ADMIN.id);
  });

  it("records the invitation on the user's auth timeline", async () => {
    await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    expect(recordAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: TARGET.id,
        email: TARGET.email,
        eventType: "invitation_sent",
      }),
    );
  });

  it("never puts a token, link or session into the audit trail", async () => {
    await usersService.resendInvite(TARGET.id, { actor: SUPER_ADMIN });

    const serialised = JSON.stringify([recordOrWarn.mock.calls, recordAuthEvent.mock.calls]);

    for (const forbidden of ["token", "access_token", "redirectTo", "auth/callback", "password"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe("the service never logs sensitive data", () => {
  it("has no console call anywhere in the resend path", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/modules/users/services/users.service.ts", "utf8");

    const fn = source.slice(source.indexOf("async function resendInvite"));
    const body = fn.slice(0, fn.indexOf("\nexport const usersService"));

    expect(body).not.toMatch(/console\./);
    expect(body).not.toMatch(/logger\.(info|debug)/);
  });
});
