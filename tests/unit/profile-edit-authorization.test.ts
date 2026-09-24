import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * Profile edits are authorized in the service, field by field (M03).
 *
 * `updateProfile` checked nothing before M03. Both real roles hold all three
 * permissions it now asks for, so the check changes nothing for them — which is
 * also why these tests need a stand-in role that lacks one. The refusal happens
 * before any database access, so no database is involved.
 */

vi.mock("@/config/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/roles")>();

  return {
    ...actual,
    /* "limited": may edit names, notes and PINs, but may not allocate. */
    roleHasPermission: (role: string, permission: string) =>
      role === "limited"
        ? permission !== actual.PERMISSIONS.PREPARE_SUBSCRIPTIONS
        : actual.roleHasPermission(role as never, permission as never),
  };
});

const findOrCreateByPhone = vi.fn();
const transaction = vi.fn();

/* Stands in for the database: records whether an edit got as far as writing. */
vi.mock("@/lib/database", () => ({
  databaseAdapter: {
    transaction: (name: string, work: unknown) => transaction(name, work),
  },
}));

vi.mock("@/modules/customers", () => ({
  customersService: { findOrCreateByPhone: (phone: string) => findOrCreateByPhone(phone) },
}));

const { profilesService } = await import("@/modules/accounts/services/profiles.service");

const LIMITED = {
  id: "limited-1",
  email: "limited@example.com",
  displayName: "Limited",
  initials: "L",
  role: "limited",
} as unknown as AppUser;

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  findOrCreateByPhone.mockReset();
  transaction.mockReset().mockResolvedValue({ ok: false, error: new Error("stubbed") });
});

describe("which fields a role may change", () => {
  it.each([
    ["the sale date", { saleDate: "2026-09-01" }],
    ["the duration", { durationDays: 30 }],
    ["the customer", { customerPhone: "0663947116" }],
    ["a note together with a date", { notes: "ok", saleDate: "2026-09-01" }],
  ])("refuses %s to a role without PREPARE_SUBSCRIPTIONS", async (_label, input) => {
    const result = await profilesService.updateProfile(PROFILE_ID, input, { actor: LIMITED });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    /* Refused before anything is resolved or written. */
    expect(findOrCreateByPhone).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not refuse the same role a note or a name", async () => {
    const result = await profilesService.updateProfile(
      PROFILE_ID,
      { notes: "A note", profileName: "Kids" },
      { actor: LIMITED },
    );

    /* Past authorization: it reached the write. */
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it("refuses a caller with no session, whatever the field", async () => {
    const result = await profilesService.updateProfile(
      PROFILE_ID,
      { notes: "A note" },
      { actor: null },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(transaction).not.toHaveBeenCalled();
  });
});
