import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";
import { ok } from "@/utils/result";

/**
 * Who may read account credentials (M03 revision).
 *
 * VIEW_ACCOUNTS, checked in the service for both the single reveal and the bulk
 * Copy Credentials. Both real roles hold it, so a stand-in role without it is
 * what proves the check is there. Refused before any database read.
 */

vi.mock("@/config/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/roles")>();

  return {
    ...actual,
    roleHasPermission: (role: string, permission: string) =>
      role === "no-view"
        ? permission !== actual.PERMISSIONS.VIEW_ACCOUNTS
        : actual.roleHasPermission(role as never, permission as never),
  };
});

const revealPassword = vi.fn();
const revealCredentials = vi.fn();
const recordOrWarn = vi.fn();

vi.mock("@/modules/accounts/repositories/accounts.repository", () => ({
  accountsRepository: {
    revealPassword: (id: string) => revealPassword(id),
    revealCredentials: (ids: string[]) => revealCredentials(ids),
  },
}));

vi.mock("@/modules/audit", () => ({
  auditService: { recordOrWarn: (i: unknown, c: unknown) => recordOrWarn(i, c) },
}));

const { accountsService } = await import("@/modules/accounts/services/accounts.service");

const NO_VIEW = {
  id: "u-1",
  email: "x@example.com",
  displayName: "X",
  initials: "X",
  role: "no-view",
} as unknown as AppUser;

const WORKER: AppUser = { ...NO_VIEW, role: "worker" };

beforeEach(() => {
  revealPassword.mockReset().mockResolvedValue(ok("Secret-Pass-1!"));
  revealCredentials
    .mockReset()
    .mockResolvedValue(ok([{ id: "a", email: "a@x.com", password: "Secret-Pass-1!" }]));
  recordOrWarn.mockReset();
});

describe("credential reads are authorized on the server", () => {
  it("refuses the bulk copy to a role without VIEW_ACCOUNTS, before any read", async () => {
    const result = await accountsService.revealCredentials(["a"], { actor: NO_VIEW });

    expect(result.ok || result.error.code).toBe("FORBIDDEN");
    expect(revealCredentials).not.toHaveBeenCalled();
  });

  it("refuses the single reveal to the same role — it checked nothing before", async () => {
    const result = await accountsService.revealPassword("a", { actor: NO_VIEW });

    expect(result.ok || result.error.code).toBe("FORBIDDEN");
    expect(revealPassword).not.toHaveBeenCalled();
  });

  it("allows a Worker, who could already copy credentials one account at a time", async () => {
    const result = await accountsService.revealCredentials(["a"], { actor: WORKER });

    expect(result.ok && result.value).toEqual([{ email: "a@x.com", password: "Secret-Pass-1!" }]);
  });

  it("audits the read without the password", async () => {
    await accountsService.revealCredentials(["a"], { actor: WORKER });

    expect(recordOrWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(recordOrWarn.mock.calls)).not.toContain("Secret-Pass-1!");
    expect(recordOrWarn.mock.calls[0]?.[0]).toMatchObject({
      entity: "account",
      entityId: "a",
      after: { event: "password_revealed" },
    });
  });

  it.each([
    ["not a list", "a"],
    ["an empty list", []],
    ["more than one page of ids", Array.from({ length: 101 }, (_, i) => `id-${i}`)],
  ])("refuses %s before any read", async (_label, ids) => {
    const result = await accountsService.revealCredentials(ids, { actor: WORKER });

    expect(result.ok || result.error.code).toBe("VALIDATION_ERROR");
    expect(revealCredentials).not.toHaveBeenCalled();
  });
});
