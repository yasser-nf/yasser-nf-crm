import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * Quick Renew is authorized in the SERVICE, not in the page or the action.
 * M09 §3 and §22.
 *
 * Both real roles hold RENEW_SUBSCRIPTIONS — that is the point of granting it —
 * so proving the gate exists needs a stand-in role that lacks it, exactly as
 * `profile-edit-authorization.test.ts` does for allocation fields.
 *
 * The assertion that matters is the second one in each case: the refusal
 * happens before the database is touched at all. A check that runs after the
 * read would still leak whether an account with that email exists.
 */

vi.mock("@/config/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/roles")>();

  return {
    ...actual,
    /* "limited": an operational role that may do everything except renew. */
    roleHasPermission: (role: string, permission: string) =>
      role === "limited"
        ? permission !== actual.PERMISSIONS.RENEW_SUBSCRIPTIONS
        : actual.roleHasPermission(role as never, permission as never),
  };
});

const query = vi.fn();
const transaction = vi.fn();

vi.mock("@/lib/database", () => ({
  databaseAdapter: {
    query: (name: string, work: unknown) => query(name, work),
    transaction: (name: string, work: unknown) => transaction(name, work),
  },
}));

const { quickRenewService } = await import("@/modules/quick-renew/services/quick-renew.service");

const LIMITED = {
  id: "limited-1",
  email: "limited@example.invalid",
  displayName: "Limited",
  initials: "L",
  role: "limited",
} as unknown as AppUser;

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111112";
const CUSTOMER_ID = "11111111-1111-4111-8111-111111111113";

const confirmation = {
  profileId: PROFILE_ID,
  accountId: ACCOUNT_ID,
  customerId: CUSTOMER_ID,
  expectedExpirationDate: "2026-10-20",
  duration: { kind: "preset" as const, preset: "3_months" as const },
  operationId: "11111111-1111-4111-8111-111111111114",
};

beforeEach(() => {
  query.mockReset().mockResolvedValue({ ok: false, error: new Error("stubbed") });
  transaction.mockReset().mockResolvedValue({ ok: false, error: new Error("stubbed") });
});

describe("a role without the renew permission", () => {
  it("cannot look up an account, and no query runs", async () => {
    const result = await quickRenewService.preview(
      { accountEmail: "stock@example.invalid" },
      { actor: LIMITED },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FORBIDDEN");
    expect(query).not.toHaveBeenCalled();
  });

  it("cannot quote a renewal, and no query runs", async () => {
    const result = await quickRenewService.quote(
      { profileId: PROFILE_ID, duration: { kind: "custom", days: 30 } },
      { actor: LIMITED },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FORBIDDEN");
    expect(query).not.toHaveBeenCalled();
  });

  it("cannot confirm one, and no transaction opens", async () => {
    const result = await quickRenewService.confirm(confirmation, { actor: LIMITED });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FORBIDDEN");
    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("is told it lacks permission, without being told what exists", async () => {
    const result = await quickRenewService.preview(
      { accountEmail: "stock@example.invalid" },
      { actor: LIMITED },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.userMessage).toBe("You do not have permission to renew subscriptions.");
    expect(result.error.userMessage).not.toContain("stock@example.invalid");
  });
});

describe("no signed-in actor", () => {
  it.each([
    [
      "preview",
      () => quickRenewService.preview({ accountEmail: "stock@example.invalid" }, { actor: null }),
    ],
    [
      "quote",
      () =>
        quickRenewService.quote(
          { profileId: PROFILE_ID, duration: { kind: "custom", days: 30 } },
          { actor: null },
        ),
    ],
    ["confirm", () => quickRenewService.confirm(confirmation, { actor: null })],
  ])("refuses %s", async (_label, call) => {
    const result = await call();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FORBIDDEN");
    expect(query).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("the permission check is reached before validation", () => {
  it("refuses a malformed request from an unauthorized role as FORBIDDEN", async () => {
    /*
     * Order matters for disclosure. If validation ran first, a role that may
     * not renew would learn which fields the endpoint expects and which values
     * it accepts. The authorization answer has to come first.
     */
    const result = await quickRenewService.confirm({ nonsense: true }, { actor: LIMITED });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FORBIDDEN");
  });
});
