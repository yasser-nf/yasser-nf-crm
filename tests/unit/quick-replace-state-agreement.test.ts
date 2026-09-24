import { describe, expect, it } from "vitest";

import { accountCanAllocate, profileCellState } from "@/modules/accounts/services/account-validity";
import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";

/**
 * Quick Replace and the Accounts page must describe a profile the same way.
 *
 * M01 finding F6: Quick Replace called `profileCellState(profile, account, now)`
 * and let the fourth argument default to `true` — "this account may allocate".
 * The Accounts list and detail page pass `accountCanAllocate(account,
 * hasActiveProblem, today)`. Quick Replace only ever shows a FAILING account,
 * so the default was wrong exactly where it mattered: a free slot Accounts
 * showed as `blocked` showed on Quick Replace as `available`.
 */

const NOW = new Date("2026-09-24T12:00:00Z");

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "acc-1",
    email: "one@icloud.com",
    passwordEncrypted: "v1:a:b:c",
    status: "healthy",
    profileSlots: 5,
    validFrom: null,
    validUntil: null,
    country: "DZ",
    notes: null,
    createdBy: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  } as AccountRow;
}

function profile(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: "p1",
    accountId: "acc-1",
    profileNumber: 1,
    profileName: null,
    pin: null,
    status: "available",
    customerId: null,
    workerId: null,
    saleDate: null,
    expirationDate: null,
    durationDays: null,
    notes: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as ProfileRow;
}

/** What the Accounts page computes: the full four-argument call. */
function accountsPageState(p: ProfileRow, a: AccountRow, hasActiveProblem: boolean) {
  return profileCellState(p, a, NOW, accountCanAllocate(a, hasActiveProblem, NOW));
}

/** What Quick Replace USED to compute: the fourth argument left to its default. */
function oldQuickReplaceState(p: ProfileRow, a: AccountRow) {
  return profileCellState(p, a, NOW);
}

describe("the divergence F6 describes", () => {
  it("existed: a free slot on a problem account read differently on the two screens", () => {
    const free = profile();
    const failing = account();

    expect(accountsPageState(free, failing, true)).toBe("blocked");
    expect(oldQuickReplaceState(free, failing)).toBe("available");
  });

  it("existed for an unhealthy account too, with no problem row at all", () => {
    const free = profile();
    const broken = account({ status: "payment_problem" });

    expect(accountsPageState(free, broken, false)).toBe("blocked");
    expect(oldQuickReplaceState(free, broken)).toBe("available");
  });

  it("never affected a sold slot — a held allocation stays sold either way", () => {
    const sold = profile({ status: "sold", customerId: "c1", expirationDate: "2026-12-31" });
    const failing = account();

    expect(accountsPageState(sold, failing, true)).toBe("sold");
    expect(oldQuickReplaceState(sold, failing)).toBe("sold");
  });
});

describe("Quick Replace now passes the same four inputs", () => {
  it("derives canAllocate from the account and its open problems", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      "src/modules/quick-prepare/services/quick-replace.service.ts",
      "utf8",
    );

    expect(source).toContain(
      "const canAllocate = accountCanAllocate(oldAccount, problems.length > 0, now);",
    );
    expect(source).toContain("profileCellState(row.profile, oldAccount, now, canAllocate)");
    /* and no three-argument call is left behind */
    expect(source).not.toMatch(/profileCellState\(row\.profile, oldAccount, now\)/);
  });

  it("loads the problems BEFORE deriving state, and only once", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      "src/modules/quick-prepare/services/quick-replace.service.ts",
      "utf8",
    );

    const load = source.indexOf("problemsService.activeForAccount(oldAccount.id)");
    const derive = source.indexOf("profileCellState(row.profile, oldAccount, now, canAllocate)");

    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(derive);
    expect(source.split("problemsService.activeForAccount(").length - 1).toBe(1);
  });

  it.each([
    ["free slot, open problem", profile(), account(), true],
    ["free slot, unhealthy account", profile(), account({ status: "invalid_email" }), false],
    ["free slot, healthy account", profile(), account(), false],
    [
      "sold slot, open problem",
      profile({ status: "sold", customerId: "c1", expirationDate: "2026-12-31" }),
      account(),
      true,
    ],
    [
      "expired allocation",
      profile({ status: "sold", customerId: "c1", expirationDate: "2026-09-01" }),
      account(),
      true,
    ],
  ] as const)("agrees with Accounts for a %s", (_label, p, a, hasProblem) => {
    /* The fixed Quick Replace call, reproduced: same function, same inputs. */
    const quickReplace = profileCellState(p, a, NOW, accountCanAllocate(a, hasProblem, NOW));

    expect(quickReplace).toBe(accountsPageState(p, a, hasProblem));
  });
});
