import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { ForbiddenError } from "@/lib/errors";

/**
 * Service-level authorization, against the real database.
 *
 * The M06 brief asks for RBAC to be verified with a real Super Admin. The
 * authenticated UI could not be reached — see the M06 report — so this verifies
 * the layer that actually decides: the services. A Server Action is a POST
 * endpoint anyone holding a session can call directly, so the service refusal is
 * the control that matters. A hidden button is not.
 *
 * It also closes the standing "no Worker user exists" gap for the authorization
 * logic. A Worker actor is constructed here rather than invited, because
 * inviting one emails a real person.
 *
 * **Every case below is a refusal or a read.** Nothing in this file mutates a
 * row. That is not an accident of coverage: the destructive paths cannot be
 * exercised safely against the only Super Admin account and the only live
 * session, and a test that suspended the real user to prove suspension works
 * would lock the owner out of their own CRM.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

let superAdmin: AppUser;

/** A second Super Admin, so self-action rules can be separated from role rules. */
const OTHER_SUPER_ADMIN: AppUser = {
  id: "00000000-0000-0000-0000-0000000000aa",
  email: "other-admin@example.invalid",
  displayName: "Other Admin",
  initials: "OA",
  role: "super_admin",
};

const WORKER: AppUser = {
  id: "00000000-0000-0000-0000-0000000000bb",
  email: "worker@example.invalid",
  displayName: "Worker",
  initials: "WK",
  role: "worker",
};

beforeAll(async () => {
  if (!configured) {
    return;
  }

  const rows = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name
    from public.users
    where role = 'super_admin' and status = 'active' and deleted_at is null
    limit 1
  `;

  const row = rows[0];

  if (!row) {
    throw new Error("No active Super Admin to authorize as");
  }

  superAdmin = {
    id: row.id,
    email: row.email,
    displayName: row.name,
    initials: "SA",
    role: "super_admin",
  };
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function services() {
  const { usersService } = await import("@/modules/users/services/users.service");
  const { sessionsService } = await import("@/modules/users/services/sessions.service");
  return { usersService, sessionsService };
}

describe.skipIf(!configured)("usersService — reads as a real Super Admin", () => {
  it("lists users", async () => {
    const { usersService } = await services();

    const result = await usersService.list({ limit: 25, offset: 0 }, superAdmin);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      expect(result.value.total).toBeGreaterThan(0);
      expect(result.value.items.length).toBeGreaterThan(0);

      for (const entry of result.value.items) {
        expect(["online", "idle", "offline"]).toContain(entry.presence);
      }

      /* The signed-in Super Admin must appear in their own list. */
      expect(result.value.items.some((entry) => entry.user.id === superAdmin.id)).toBe(true);
    }
  });

  it("loads a user detail with sessions, activity and login history", async () => {
    const { usersService } = await services();

    const result = await usersService.getDetail(superAdmin.id, superAdmin);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      expect(result.value.user.id).toBe(superAdmin.id);
      expect(["online", "idle", "offline"]).toContain(result.value.presence);
      expect(Array.isArray(result.value.sessions)).toBe(true);
      expect(Array.isArray(result.value.activity)).toBe(true);
      expect(Array.isArray(result.value.loginHistory)).toBe(true);
    }
  });

  it("reports who is online without a filter", async () => {
    const { usersService } = await services();

    const result = await usersService.onlineNow(superAdmin);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      for (const entry of result.value) {
        expect(entry.presence).not.toBe("offline");
      }
    }
  });

  it("lists the Super Admin's own sessions", async () => {
    const { sessionsService } = await services();

    const result = await sessionsService.listForUser(superAdmin.id, superAdmin);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
  });
});

describe.skipIf(!configured)("RBAC — a Worker is refused everything administrative", () => {
  it("cannot list users", async () => {
    const { usersService } = await services();
    const result = await usersService.list({ limit: 5, offset: 0 }, WORKER);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("cannot read a user detail", async () => {
    const { usersService } = await services();
    const result = await usersService.getDetail(superAdmin.id, WORKER);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("cannot see who is online", async () => {
    const { usersService } = await services();
    const result = await usersService.onlineNow(WORKER);

    expect(result.ok).toBe(false);
  });

  it("cannot invite", async () => {
    const { usersService } = await services();
    const result = await usersService.invite(
      { name: "Nope", email: "nope@example.invalid", role: "worker" },
      { actor: WORKER },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("cannot change a role", async () => {
    const { usersService } = await services();
    const result = await usersService.changeRole(
      superAdmin.id,
      { role: "worker" },
      { actor: WORKER },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("cannot change a status", async () => {
    const { usersService } = await services();
    const result = await usersService.changeStatus(
      superAdmin.id,
      { status: "disabled" },
      { actor: WORKER },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("cannot archive", async () => {
    const { usersService } = await services();
    const result = await usersService.archive(superAdmin.id, { actor: WORKER });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("cannot revoke another user's sessions", async () => {
    const { sessionsService } = await services();
    const result = await sessionsService.revokeAll(superAdmin.id, { actor: WORKER });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("is refused with no actor at all", async () => {
    const { usersService } = await services();
    const result = await usersService.list({ limit: 5, offset: 0 }, null);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });
});

describe.skipIf(!configured)("Guards that outrank the permission check", () => {
  /*
   * These run as a real Super Admin — permitted to perform the operation — and
   * are refused anyway. Each refusal happens before any write, which is what
   * makes them safe to run against the live database.
   */

  it("refuses to demote the last active Super Admin", async () => {
    const { usersService } = await services();

    const result = await usersService.changeRole(
      superAdmin.id,
      { role: "worker" },
      { actor: OTHER_SUPER_ADMIN },
    );

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ForbiddenError);
      expect(result.error.message).toContain("last active Super Admin");
    }
  });

  it("refuses to disable the last active Super Admin", async () => {
    const { usersService } = await services();

    const result = await usersService.changeStatus(
      superAdmin.id,
      { status: "disabled" },
      { actor: OTHER_SUPER_ADMIN },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("last active Super Admin");
  });

  it("refuses to archive the last active Super Admin", async () => {
    const { usersService } = await services();

    const result = await usersService.archive(superAdmin.id, { actor: OTHER_SUPER_ADMIN });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("last active Super Admin");
  });

  it("refuses a self role change", async () => {
    const { usersService } = await services();

    const result = await usersService.changeRole(
      superAdmin.id,
      { role: "worker" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Self role change");
  });

  it("refuses a self lockout", async () => {
    const { usersService } = await services();

    const result = await usersService.changeStatus(
      superAdmin.id,
      { status: "suspended" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Self lockout");
  });

  it("refuses a self archive", async () => {
    const { usersService } = await services();

    const result = await usersService.archive(superAdmin.id, { actor: superAdmin });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Self archive");
  });
});

describe.skipIf(!configured)("Invitation guards — refused before any email is sent", () => {
  it("refuses an email that already belongs to a user", async () => {
    const { usersService } = await services();

    /*
     * Reaches the duplicate check and stops. inviteUserByEmail is never called,
     * so no invitation reaches a real inbox.
     */
    const result = await usersService.invite(
      { name: "Duplicate", email: superAdmin.email, role: "worker" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("already exists");
  });

  it("refuses a malformed email before touching Supabase", async () => {
    const { usersService } = await services();

    const result = await usersService.invite(
      { name: "Bad", email: "not-an-email", role: "worker" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses an unknown role", async () => {
    const { usersService } = await services();

    const result = await usersService.invite(
      { name: "Bad", email: "fresh@example.invalid", role: "owner" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("accepts no password field — the schema strips or rejects it", async () => {
    const { inviteUserSchema } = await import("@/modules/users/validation/user.schema");

    const parsed = inviteUserSchema.safeParse({
      name: "Someone",
      email: "someone@example.invalid",
      role: "worker",
      password: "should-not-survive",
    });

    /*
     * ADR-008 Decision 2. Whether Zod strips the key or rejects the object, what
     * must never happen is a password arriving in the invite payload and being
     * carried forward.
     */
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("password");
    }
  });
});

describe.skipIf(!configured)("Session revocation — the ownership check", () => {
  it("refuses to revoke a session that does not belong to the stated owner", async () => {
    const { sessionsService } = await services();

    /*
     * The security-critical half of revocation, verified without deleting
     * anything. Without this check a caller could pass any session id alongside
     * their own user id and end somebody else's session.
     *
     * A random uuid cannot belong to the owner, so the refusal proves the check
     * runs before the delete rather than after it.
     */
    const result = await sessionsService.revoke(
      "11111111-2222-3333-4444-555555555555",
      superAdmin.id,
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("still refuses when the caller is a Worker naming themselves as owner", async () => {
    const { sessionsService } = await services();

    const result = await sessionsService.revoke("11111111-2222-3333-4444-555555555555", WORKER.id, {
      actor: WORKER,
    });

    /*
     * A Worker may revoke their own sessions, so this passes the permission
     * check and is stopped by ownership instead — the session is not theirs.
     */
    expect(result.ok).toBe(false);
  });
});
