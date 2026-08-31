import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildChangePasswordSchema } from "@/modules/auth/validation/change-password.schema";

/**
 * Changing your own password.
 *
 * Two things are worth pinning. The first is that the rules come from the
 * CONFIGURED policy — `security.passwordMinLength`, which a Super Admin edits —
 * rather than from a number written into this feature. The second is that the
 * current password is actually verified: Supabase's `updateUser({ password })`
 * succeeds on any valid session without asking for the old one, so an
 * unattended unlocked machine would otherwise be enough to take an account over.
 *
 * The service talks to Supabase, so the client is mocked. What is asserted is
 * the ORDER and the CONDITIONS — that re-authentication happens first, and that
 * nothing is updated when it fails.
 */

const signInWithPassword = vi.fn();
const updateUser = vi.fn();
const getSession = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createSupabaseBrowserClient: () => ({
    auth: { signInWithPassword, updateUser, getSession },
  }),
}));

vi.mock("@/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/env")>()),
  isSupabaseConfigured: () => true,
}));

const CONTEXT = { email: "admin@example.com", passwordMinLength: 12 };

const VALID = {
  currentPassword: "current-password-1",
  newPassword: "a-brand-new-password-2",
  confirmPassword: "a-brand-new-password-2",
};

async function changePassword(input: Record<string, string>) {
  const { authService } = await import("@/modules/auth/services/auth.service");
  return authService.changePassword(input as never, CONTEXT);
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });
  signInWithPassword.mockResolvedValue({ data: {}, error: null });
  updateUser.mockResolvedValue({ data: {}, error: null });
});

describe("the configured policy is the rule, not a number in this feature", () => {
  it("enforces whatever passwordMinLength is set to", () => {
    /* Default is 12; an administrator may set anything from 8 to 128. */
    const strict = buildChangePasswordSchema(20);
    const relaxed = buildChangePasswordSchema(8);

    const twelve = {
      currentPassword: "old",
      newPassword: "x".repeat(12),
      confirmPassword: "x".repeat(12),
    };

    expect(strict.safeParse(twelve).success, "12 is too short when the policy says 20").toBe(false);
    expect(relaxed.safeParse(twelve).success, "and long enough when it says 8").toBe(true);
  });

  it("names the configured length in the message", () => {
    const result = buildChangePasswordSchema(16).safeParse({
      currentPassword: "old",
      newPassword: "short",
      confirmPassword: "short",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.message.includes("16"))).toBe(true);
  });
});

describe("validation", () => {
  const schema = buildChangePasswordSchema(12);

  it("mismatched new passwords are rejected, against the confirm field", () => {
    const result = schema.safeParse({
      currentPassword: "current-password-1",
      newPassword: "a-brand-new-password-2",
      confirmPassword: "a-different-password-3",
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    const issue = result.error.issues.find((i) => i.path[0] === "confirmPassword");
    expect(issue?.message).toMatch(/do not match/i);
  });

  it("a weak password is rejected, against the new-password field", () => {
    const result = schema.safeParse({
      currentPassword: "current-password-1",
      newPassword: "short",
      confirmPassword: "short",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === "newPassword")).toBe(true);
  });

  it("reusing the current password is rejected", () => {
    const same = "current-password-1";
    const result = schema.safeParse({
      currentPassword: same,
      newPassword: same,
      confirmPassword: same,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === "newPassword")).toBe(true);
  });

  it("an empty current password is rejected", () => {
    const result = schema.safeParse({ ...VALID, currentPassword: "" });
    expect(result.success).toBe(false);
  });

  it("a password beyond bcrypt's 72-byte limit is rejected here, not by Supabase", () => {
    const tooLong = "x".repeat(73);
    const result = schema.safeParse({
      currentPassword: "current-password-1",
      newPassword: tooLong,
      confirmPassword: tooLong,
    });

    expect(result.success).toBe(false);
  });

  it("a valid change passes", () => {
    expect(schema.safeParse(VALID).success).toBe(true);
  });
});

describe("the service verifies the current password before changing anything", () => {
  it("successful change: re-authenticates, then updates", async () => {
    const result = await changePassword(VALID);

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: CONTEXT.email,
      password: VALID.currentPassword,
    });
    expect(updateUser).toHaveBeenCalledWith({ password: VALID.newPassword });

    /* Order matters: proving identity must come first. */
    expect(signInWithPassword.mock.invocationCallOrder[0]).toBeLessThan(
      updateUser.mock.invocationCallOrder[0]!,
    );
  });

  it("incorrect current password: rejected, and nothing is updated", async () => {
    signInWithPassword.mockResolvedValue({
      data: {},
      error: { status: 400, message: "Invalid login credentials", name: "AuthApiError" },
    });

    const result = await changePassword(VALID);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(
      (result.error as { fieldErrors?: Record<string, string> }).fieldErrors?.["currentPassword"],
      "the message lands under the field at fault",
    ).toBeDefined();

    expect(updateUser, "the password was NOT changed").not.toHaveBeenCalled();
  });

  it("unauthenticated: refused before any credential is sent", async () => {
    getSession.mockResolvedValue({ data: { session: null } });

    const result = await changePassword(VALID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED");

    expect(signInWithPassword, "no re-authentication attempted").not.toHaveBeenCalled();
    expect(updateUser, "and nothing updated").not.toHaveBeenCalled();
  });

  it("invalid input never reaches Supabase at all", async () => {
    const result = await changePassword({ ...VALID, confirmPassword: "does-not-match" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");

    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("the service revalidates rather than trusting the form", async () => {
    /* A short password that a tampered client could have sent anyway. */
    const weak = {
      currentPassword: "current-password-1",
      newPassword: "short",
      confirmPassword: "short",
    };

    const result = await changePassword(weak);

    expect(result.ok).toBe(false);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("a rejection from Supabase's own policy surfaces its wording", async () => {
    updateUser.mockResolvedValue({
      data: {},
      error: {
        status: 400,
        message: "Password should contain at least one symbol",
        name: "AuthApiError",
      },
    });

    const result = await changePassword(VALID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.userMessage).toMatch(/symbol/i);
  });

  it("a rate-limited change is reported as such, not as a wrong password", async () => {
    signInWithPassword.mockResolvedValue({
      data: {},
      error: { status: 429, message: "Too many requests", name: "AuthApiError" },
    });

    const result = await changePassword(VALID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.userMessage).toMatch(/too many/i);
    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe("passwords are never persisted by this feature", () => {
  it("the service returns no value, so nothing can carry a password onward", async () => {
    const result = await changePassword(VALID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    /* VoidResult: success carries nothing. */
    expect((result as { value?: unknown }).value).toBeUndefined();
  });

  it("a validation failure reports field NAMES, never the values typed", async () => {
    const secret = "a-brand-new-password-2";
    const result = await changePassword({ ...VALID, confirmPassword: "different" });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const serialised = JSON.stringify({
      message: result.error.message,
      userMessage: result.error.userMessage,
      fieldErrors: (result.error as { fieldErrors?: unknown }).fieldErrors,
    });

    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain(VALID.currentPassword);
  });
});
