import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { sanitizeAuditSnapshot } from "@/modules/audit/services/audit-redaction";
import { fail, ok } from "@/utils/result";

/**
 * Direct user creation (M02, ADR-014).
 *
 * The one place in the CRM a password passes through application code, so most
 * of this file is about where it must NOT go: public.users, the audit entry, a
 * log line, an error, or the value returned to the browser. The rest is the
 * authorization, validation and the two-system consistency around it.
 *
 * Supabase Auth is replaced by a recording stand-in. What that proves and what
 * it cannot — a real password sign-in — is stated in the "can authenticate"
 * block below.
 */

const PASSWORD = "Correct-Horse-Battery-9";
const NEW_ID = "11111111-1111-4111-8111-111111111111";

const findByEmail = vi.fn();
const createRow = vi.fn();
const createAuthUser = vi.fn();
const deleteAuthUser = vi.fn();
const recordOrWarn = vi.fn();
const security = vi.fn();

vi.mock("@/modules/users/repositories/users.repository", () => ({
  usersRepository: {
    findByEmail: (email: string) => findByEmail(email),
    create: (input: unknown) => createRow(input),
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () =>
    ok({
      auth: {
        admin: {
          createUser: (attributes: unknown) => createAuthUser(attributes),
          deleteUser: (id: string) => deleteAuthUser(id),
        },
      },
    }),
}));

vi.mock("@/modules/audit", () => ({
  auditService: { recordOrWarn: (i: unknown, c: unknown) => recordOrWarn(i, c) },
}));

vi.mock("@/modules/settings", () => ({
  configurationService: { security: () => security() },
}));

const currentUser = vi.fn();

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: () => currentUser() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { usersService, assignableRoles, CREATE_FAILURE } =
  await import("@/modules/users/services/users.service");
const { createUserAction } = await import("@/modules/users/actions/user.actions");

const SUPER_ADMIN: AppUser = {
  id: "admin-1",
  email: "admin@example.com",
  displayName: "Admin",
  initials: "A",
  role: "super_admin",
};

const WORKER: AppUser = { ...SUPER_ADMIN, id: "worker-1", role: "worker" };

const VALID = {
  name: "  Amina Belkacem ",
  email: "  Amina@Example.COM ",
  password: PASSWORD,
  role: "worker",
};

function storedRow(input: Record<string, unknown>) {
  return {
    ...input,
    lastLoginAt: null,
    createdAt: new Date("2026-09-24T12:00:00Z"),
    updatedAt: new Date("2026-09-24T12:00:00Z"),
    deletedAt: null,
  };
}

/** Everything the logger wrote during a test, as one string. */
let logged: string[] = [];

beforeEach(() => {
  for (const m of [
    findByEmail,
    createRow,
    createAuthUser,
    deleteAuthUser,
    recordOrWarn,
    security,
    currentUser,
  ]) {
    m.mockReset();
  }

  security.mockResolvedValue({ passwordMinLength: 12 });
  findByEmail.mockResolvedValue(fail(new NotFoundError("User not found")));
  createAuthUser.mockResolvedValue({ data: { user: { id: NEW_ID } }, error: null });
  deleteAuthUser.mockResolvedValue({ data: { user: null }, error: null });
  createRow.mockImplementation(async (input: Record<string, unknown>) => ok(storedRow(input)));
  recordOrWarn.mockResolvedValue(undefined);
  currentUser.mockResolvedValue(SUPER_ADMIN);

  logged = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const create = (input: unknown, actor: AppUser | null = SUPER_ADMIN) =>
  usersService.create(input, { actor });

/* ------------------------------------------------------------------------- */

describe("an authorized administrator creates a user", () => {
  it("creates the auth identity and the CRM row, and returns the row", async () => {
    const result = await create(VALID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toMatchObject({
      id: NEW_ID,
      name: "Amina Belkacem",
      email: "amina@example.com",
      role: "worker",
      status: "active",
    });
  });

  it("asks Supabase for a CONFIRMED identity — usable without any email", async () => {
    await create(VALID);

    expect(createAuthUser).toHaveBeenCalledTimes(1);
    /* Exactly these keys: no role or name in user-editable metadata. */
    expect(createAuthUser).toHaveBeenCalledWith({
      email: "amina@example.com",
      password: PASSWORD,
      email_confirm: true,
    });
  });

  it("writes public.users with Supabase's id, the chosen role, and no password", async () => {
    await create({ ...VALID, role: "super_admin" });

    expect(createRow).toHaveBeenCalledTimes(1);
    const row = createRow.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(row).toEqual({
      id: NEW_ID,
      name: "Amina Belkacem",
      email: "amina@example.com",
      role: "super_admin",
      status: "active",
    });
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
  });

  it("normalizes the email the same way the rest of the module does", async () => {
    await create(VALID);

    expect(findByEmail).toHaveBeenCalledWith("amina@example.com");
  });

  it("records one audit entry naming the target, role, email and what happened", async () => {
    await create(VALID, SUPER_ADMIN);

    expect(recordOrWarn).toHaveBeenCalledTimes(1);
    const [entry, context] = recordOrWarn.mock.calls[0] as [Record<string, unknown>, unknown];

    expect(entry).toMatchObject({
      entity: "user",
      entityId: NEW_ID,
      action: "create",
      after: { id: NEW_ID, email: "amina@example.com", role: "worker", event: "user_created" },
    });
    /* The actor travels in the context; the audit service stamps who and when. */
    expect(context).toEqual({ actor: SUPER_ADMIN });
  });
});

describe("authorization is the service's, not the form's", () => {
  it("refuses a Worker, before Supabase is asked for anything", async () => {
    const result = await create(VALID, WORKER);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
    expect(createAuthUser).not.toHaveBeenCalled();
    expect(createRow).not.toHaveBeenCalled();
    expect(recordOrWarn).not.toHaveBeenCalled();
  });

  it("refuses a caller with no session", async () => {
    const result = await create(VALID, null);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
    expect(createAuthUser).not.toHaveBeenCalled();
  });

  it("offers roles straight from the existing permission matrix", () => {
    expect(assignableRoles("super_admin")).toEqual(["worker", "super_admin"]);
    expect(assignableRoles("worker")).toEqual([]);
  });

  it("refuses a Worker even when they name the least privileged role", async () => {
    const result = await create({ ...VALID, role: "worker" }, WORKER);

    expect(result.ok).toBe(false);
    expect(createAuthUser).not.toHaveBeenCalled();
  });
});

describe("validation", () => {
  it.each([
    ["missing", ""],
    ["no at-sign", "amina.example.com"],
    ["no domain", "amina@"],
  ])("rejects an invalid email (%s)", async (_label, email) => {
    const result = await create({ ...VALID, email });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect((result.error as ValidationError).fieldErrors?.["email"]).toBeTruthy();
    }
    expect(createAuthUser).not.toHaveBeenCalled();
  });

  it.each([
    ["shorter than the configured minimum", "Short-1"],
    ["one under the minimum", "abcdefghijk"],
    ["over bcrypt's 72-byte limit", "x".repeat(73)],
    ["missing", undefined],
  ])("rejects an invalid password (%s)", async (_label, password) => {
    const result = await create({ ...VALID, password });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect((result.error as ValidationError).fieldErrors?.["password"]).toBeTruthy();
    }
    expect(createAuthUser).not.toHaveBeenCalled();
  });

  it("uses the STORED password policy, which a caller cannot lower", async () => {
    security.mockResolvedValue({ passwordMinLength: 16 });

    /* 14 characters: fine under the default 12, refused under the stored 16. */
    const result = await create({ ...VALID, password: "fourteen-chars", passwordMinLength: 4 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as ValidationError).fieldErrors?.["password"]).toBe(
        "Use at least 16 characters",
      );
    }
    expect(createAuthUser).not.toHaveBeenCalled();
  });

  it("accepts a password exactly at the minimum", async () => {
    const result = await create({ ...VALID, password: "exactly-12ch" });

    expect(result.ok).toBe(true);
  });

  it.each([["owner"], ["admin"], ["SUPER_ADMIN"], [""], [undefined]])(
    "rejects an invalid role (%s)",
    async (role) => {
      const result = await create({ ...VALID, role });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ValidationError);
        expect((result.error as ValidationError).fieldErrors?.["role"]).toBeTruthy();
      }
      expect(createAuthUser).not.toHaveBeenCalled();
    },
  );

  it("rejects an empty name", async () => {
    const result = await create({ ...VALID, name: "   " });

    expect(result.ok).toBe(false);
    if (!result.ok) expect((result.error as ValidationError).fieldErrors?.["name"]).toBeTruthy();
  });
});

describe("duplicate email", () => {
  it("refuses an address a CRM user already has, before creating anything", async () => {
    findByEmail.mockResolvedValue(ok(storedRow({ id: "existing", email: "amina@example.com" })));

    const result = await create(VALID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ConflictError);
      expect(result.error.userMessage).toBe(CREATE_FAILURE.EMAIL_TAKEN);
    }
    expect(createAuthUser).not.toHaveBeenCalled();
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });

  it("maps Supabase's email_exists to a conflict, and deletes NOTHING", async () => {
    /*
     * An address Supabase holds but no live CRM row does — an archived
     * colleague, or a dashboard-created identity. Supabase created nothing, so
     * there is nothing to undo, and the existing identity must not be touched.
     */
    createAuthUser.mockResolvedValue({
      data: { user: null },
      error: {
        code: "email_exists",
        status: 422,
        message: "A user with this email already exists",
      },
    });

    const result = await create(VALID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ConflictError);
    expect(deleteAuthUser).not.toHaveBeenCalled();
    expect(createRow).not.toHaveBeenCalled();
    expect(recordOrWarn).not.toHaveBeenCalled();
  });

  it("maps Supabase's weak_password onto the password field", async () => {
    createAuthUser.mockResolvedValue({
      data: { user: null },
      error: { code: "weak_password", status: 422, message: "Password is known to be weak" },
    });

    const result = await create(VALID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as ValidationError).fieldErrors?.["password"]).toBe(
        CREATE_FAILURE.WEAK_PASSWORD,
      );
    }
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });
});

describe("the auth identity and the CRM row cannot come apart", () => {
  it("removes the new auth identity when the CRM row fails to write", async () => {
    createRow.mockResolvedValue(fail(new ConflictError("unique violation")));

    const result = await create(VALID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.userMessage).toBe(CREATE_FAILURE.PROFILE_FAILED);

    /* Exactly the identity this call created — nothing else is ever deleted. */
    expect(deleteAuthUser).toHaveBeenCalledTimes(1);
    expect(deleteAuthUser).toHaveBeenCalledWith(NEW_ID);
    expect(recordOrWarn).not.toHaveBeenCalled();
  });

  it("still compensates when the write throws instead of failing", async () => {
    createRow.mockRejectedValue(new Error(`connection reset while inserting ${PASSWORD}`));

    const result = await create(VALID);

    expect(result.ok).toBe(false);
    expect(deleteAuthUser).toHaveBeenCalledWith(NEW_ID);
    /* The thrown value is not carried, so its text cannot reach a log or the browser. */
    expect(logged.join("\n")).not.toContain(PASSWORD);
    if (!result.ok) expect(JSON.stringify(result.error.toLogObject())).not.toContain(PASSWORD);
  });

  it("says so plainly, and logs the orphan's id, when the compensation itself fails", async () => {
    createRow.mockResolvedValue(fail(new ConflictError("unique violation")));
    deleteAuthUser.mockResolvedValue({
      data: { user: null },
      error: { code: "unexpected_failure", status: 500, message: "boom" },
    });

    const result = await create(VALID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.userMessage).toBe(CREATE_FAILURE.ROLLBACK_FAILED);
    expect(logged.join("\n")).toContain(NEW_ID);
    expect(logged.join("\n")).toContain("orphaned auth identity");
  });

  it("never deletes anything when creation succeeds", async () => {
    await create(VALID);

    expect(deleteAuthUser).not.toHaveBeenCalled();
  });
});

describe("the password never leaves the call", () => {
  it("is absent from the audit entry — as recorded, and as the sanitizer would store it", async () => {
    await create(VALID);

    const [entry] = recordOrWarn.mock.calls[0] as [{ after: Record<string, unknown> }];

    expect(JSON.stringify(entry)).not.toContain(PASSWORD);
    expect(entry.after).not.toHaveProperty("password");
    expect(JSON.stringify(sanitizeAuditSnapshot("user", entry.after))).not.toContain(PASSWORD);
  });

  it("would be dropped by the audit layer even if a caller passed it", () => {
    /* The M01.5 allow-list: `password` is not an approved user field. */
    const stored = sanitizeAuditSnapshot("user", {
      id: NEW_ID,
      email: "amina@example.com",
      password: PASSWORD,
      credentials: { password: PASSWORD },
    });

    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(stored?.["_omitted"]).toEqual(["credentials", "password"]);
  });

  it("is absent from the returned row", async () => {
    const result = await create(VALID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toHaveProperty("password");
      expect(JSON.stringify(result.value)).not.toContain(PASSWORD);
    }
  });

  it.each([
    [
      "Supabase echoes the password in its message",
      () =>
        createAuthUser.mockResolvedValue({
          data: { user: null },
          error: { code: "weak_password", status: 422, message: `"${PASSWORD}" is too common` },
        }),
    ],
    [
      "Supabase fails with an unknown error",
      () =>
        createAuthUser.mockResolvedValue({
          data: { user: null },
          error: { code: "unexpected_failure", status: 500, message: `failed for ${PASSWORD}` },
        }),
    ],
    [
      "the CRM row fails and compensation fails",
      () => {
        createRow.mockResolvedValue(fail(new ConflictError("unique violation")));
        deleteAuthUser.mockResolvedValue({
          data: { user: null },
          error: { code: "unexpected_failure", status: 500, message: "boom" },
        });
      },
    ],
    ["validation fails on another field", () => undefined],
  ])("is absent from every error and log line when %s", async (label, arrange) => {
    arrange();

    const input = label.startsWith("validation") ? { ...VALID, email: "nope" } : VALID;
    const result = await create(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as ValidationError;
      const surfaces = [
        error.message,
        error.userMessage,
        JSON.stringify(error.toLogObject()),
        JSON.stringify(error.fieldErrors ?? {}),
      ].join("\n");

      expect(surfaces).not.toContain(PASSWORD);
    }
    expect(logged.join("\n")).not.toContain(PASSWORD);
  });
});

describe("the newly created user can authenticate", () => {
  /*
   * What is proven here, without a real Supabase: the identity is created with
   * the chosen password and `email_confirm: true`, so Supabase will accept a
   * password sign-in without any email step; and the CRM row is `active` and
   * live with the same id, which is exactly what getCurrentUser requires
   * (tests/integration/users-create.test.ts runs getCurrentUser against it).
   *
   * What is NOT proven: Supabase itself accepting that email and password. The
   * isolated test database has no GoTrue, and running this against the
   * production project would create a real user. That check belongs to the
   * deployment verification, with the owner's approval.
   */
  it("hands Supabase a confirmed identity with the password, and writes an active row", async () => {
    const result = await create(VALID);

    const attributes = createAuthUser.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(attributes["email_confirm"]).toBe(true);
    expect(attributes["password"]).toBe(PASSWORD);

    expect(result.ok && result.value.status).toBe("active");
    expect(result.ok && result.value.deletedAt).toBeNull();
    expect(result.ok && result.value.id).toBe(NEW_ID);
  });
});

describe("what the browser receives from the Server Action", () => {
  it("returns the stored row on success — no password in the response", async () => {
    const response = await createUserAction(VALID);

    expect(response.ok).toBe(true);
    expect(JSON.stringify(response)).not.toContain(PASSWORD);
  });

  it("returns field messages on failure — naming the rule, never the value", async () => {
    security.mockResolvedValue({ passwordMinLength: 40 });

    const response = await createUserAction(VALID);

    expect(response).toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: { password: "Use at least 40 characters" },
    });
    expect(JSON.stringify(response)).not.toContain(PASSWORD);
  });

  it("refuses without a session, before the service runs", async () => {
    currentUser.mockResolvedValue(null);

    const response = await createUserAction(VALID);

    expect(response).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(createAuthUser).not.toHaveBeenCalled();
  });

  it("refuses a Worker calling the action directly", async () => {
    currentUser.mockResolvedValue(WORKER);

    const response = await createUserAction(VALID);

    expect(response).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(createAuthUser).not.toHaveBeenCalled();
  });
});
