import { beforeEach, describe, expect, it, vi } from "vitest";

import { ok } from "@/utils/result";
import { profileCustomerLabel } from "@/modules/accounts/services/profile-customer";

/**
 * The cost of carrying profiles on the accounts list.
 *
 * The brief's hard constraint was "do not create 5 additional database queries
 * per account". Nothing here needed to be added to satisfy it: the accounts
 * query already loads every profile for the page in one batched `inArray`, and
 * the service was building indicators from those rows and then discarding them.
 *
 * These assert that the panel's data still costs nothing extra, and that it
 * comes from the same rows the indicators come from — so a slot cannot read one
 * way in the strip and another in the panel.
 */

const listWithCounts = vi.fn();
const accountsWithActiveProblems = vi.fn();

vi.mock("@/modules/accounts/repositories/accounts.repository", () => ({
  accountsRepository: {
    listWithCounts: (filter: unknown) => listWithCounts(filter),
  },
}));

vi.mock("@/modules/problems", () => ({
  problemsService: {
    accountsWithActiveProblems: (ids: readonly string[]) => accountsWithActiveProblems(ids),
  },
}));

const { accountsService } = await import("@/modules/accounts/services/accounts.service");

function customerRow(id: string, phoneNormalized: string) {
  return {
    id,
    name: null,
    phoneOriginal: phoneNormalized,
    phoneNormalized,
    whatsappUrl: "",
    notes: null,
    firstPurchaseAt: null,
    lastPurchaseAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    deletedAt: null,
    blockedAt: null,
  };
}

/** One slot as the joined query returns it: the profile and its customer row. */
function profile(profileNumber: number, customer: ReturnType<typeof customerRow> | null = null) {
  return {
    profile: {
      id: `p${profileNumber}`,
      accountId: "acc-1",
      profileNumber,
      profileName: null,
      pin: null,
      status: customer ? ("sold" as const) : ("available" as const),
      customerId: customer?.id ?? null,
      workerId: null,
      saleDate: null,
      expirationDate: null,
      durationDays: null,
      notes: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    customer,
  };
}

const ACCOUNT = {
  id: "acc-1",
  email: "one@icloud.com",
  passwordEncrypted: "v1:a:b:c",
  status: "healthy" as const,
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
};

/** Profiles deliberately out of order, to prove the service sorts them. */
const ROW = {
  account: ACCOUNT,
  profiles: [profile(3), profile(1), profile(5), profile(2), profile(4)],
  availableProfiles: 5,
  soldProfiles: 0,
  notForSaleProfiles: 0,
  expiredProfiles: 0,
};

beforeEach(() => {
  listWithCounts.mockReset();
  accountsWithActiveProblems.mockReset();
  listWithCounts.mockResolvedValue(ok({ items: [ROW], total: 1, limit: 25, offset: 0 }));
  accountsWithActiveProblems.mockResolvedValue(ok(new Set<string>()));
});

describe("the panel costs no extra query", () => {
  it("asks the repository for the page exactly once", async () => {
    await accountsService.listAccounts({ limit: 25, offset: 0 });

    expect(listWithCounts).toHaveBeenCalledTimes(1);
  });

  it("asks the problems module once for the whole page, not once per account", async () => {
    await accountsService.listAccounts({ limit: 25, offset: 0 });

    expect(accountsWithActiveProblems).toHaveBeenCalledTimes(1);
    expect(accountsWithActiveProblems.mock.calls[0]?.[0]).toEqual(["acc-1"]);
  });

  it("builds the profiles from rows the page query already returned", async () => {
    /*
     * The whole performance argument in one assertion: five profiles reach the
     * client having cost no call beyond the single page query.
     */
    const result = await accountsService.listAccounts({ limit: 25, offset: 0 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items[0]?.profiles).toHaveLength(5);
    }

    expect(listWithCounts).toHaveBeenCalledTimes(1);
  });
});

describe("what the panel receives", () => {
  it("orders profiles 1 to 5, whatever order the query returned", async () => {
    const result = await accountsService.listAccounts({ limit: 25, offset: 0 });

    if (result.ok) {
      expect(result.value.items[0]?.profiles.map((p) => p.profile.profileNumber)).toEqual([
        1, 2, 3, 4, 5,
      ]);
    }
  });

  it("gives every profile a state from the shared derivation", async () => {
    const result = await accountsService.listAccounts({ limit: 25, offset: 0 });

    if (result.ok) {
      expect(result.value.items[0]?.profiles.map((p) => p.state)).toEqual([
        "available",
        "available",
        "available",
        "available",
        "available",
      ]);
    }
  });

  it("agrees with the indicator strip about every slot", async () => {
    /*
     * Both are built from the same rows through the same derivation, so the
     * panel and the five chips above it cannot disagree. This is the assertion
     * that would fail if either grew its own opinion.
     */
    const result = await accountsService.listAccounts({ limit: 25, offset: 0 });

    if (result.ok) {
      const row = result.value.items[0];
      const fromIndicators = row?.indicators
        .toSorted((a, b) => a.profileNumber - b.profileNumber)
        .map((i) => i.state);

      expect(row?.profiles.map((p) => p.state)).toEqual(fromIndicators);
    }
  });

  it("marks a slot above the sellable count as not for sale", async () => {
    listWithCounts.mockResolvedValue(
      ok({
        items: [{ ...ROW, account: { ...ACCOUNT, profileSlots: 3 } }],
        total: 1,
        limit: 25,
        offset: 0,
      }),
    );

    const result = await accountsService.listAccounts({ limit: 25, offset: 0 });

    if (result.ok) {
      expect(result.value.items[0]?.profiles.map((p) => p.state)).toEqual([
        "available",
        "available",
        "available",
        "not_for_sale",
        "not_for_sale",
      ]);
    }
  });

  it("blocks every slot when the account carries an open problem", async () => {
    accountsWithActiveProblems.mockResolvedValue(ok(new Set(["acc-1"])));

    const result = await accountsService.listAccounts({ limit: 25, offset: 0 });

    if (result.ok) {
      expect(result.value.items[0]?.profiles.every((p) => p.state === "blocked")).toBe(true);
    }
  });
});

describe("customers arrive on the same query, not one each", () => {
  it("adds no query when profiles carry customers", async () => {
    /*
     * The N+1 that was never written. Naming five customers per account on a
     * 25-row page would be 125 lookups; the customer rides the join the page
     * query already makes, so the count is the same as it was with no customer
     * data at all.
     */
    listWithCounts.mockResolvedValue(
      ok({
        items: [
          {
            ...ROW,
            profiles: [
              profile(1, customerRow("cus-a", "663947116")),
              profile(2, customerRow("cus-b", "552327768")),
              profile(3),
              profile(4, customerRow("cus-d", "@third")),
              profile(5),
            ],
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
      }),
    );

    const result = await accountsService.listAccounts({ limit: 25, offset: 0 });

    expect(listWithCounts).toHaveBeenCalledTimes(1);
    expect(accountsWithActiveProblems).toHaveBeenCalledTimes(1);

    if (result.ok) {
      expect(result.value.items[0]?.profiles.map((p) => profileCustomerLabel(p.customer))).toEqual([
        "0663 94 71 16",
        "0552 32 77 68",
        "No customer assigned",
        "@third",
        "No customer assigned",
      ]);
    }
  });

  it("resolves each slot from its own customer_id", async () => {
    /*
     * Requirement 5 at the service boundary: one account, several customers,
     * none of them shared. If the service ever resolved once per ACCOUNT this
     * would return the same label five times.
     */
    listWithCounts.mockResolvedValue(
      ok({
        items: [
          {
            ...ROW,
            profiles: [
              profile(1, customerRow("cus-a", "663947116")),
              profile(2, customerRow("cus-b", "552327768")),
              profile(3, customerRow("cus-c", "540202813")),
              profile(4, customerRow("cus-d", "550174665")),
              profile(5, customerRow("cus-e", "542539318")),
            ],
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
      }),
    );

    const result = await accountsService.listAccounts({ limit: 25, offset: 0 });

    if (result.ok) {
      const ids = result.value.items[0]?.profiles.map((p) =>
        p.customer.kind === "linked" ? p.customer.customer.id : null,
      );

      expect(new Set(ids).size).toBe(5);
      expect(ids).toEqual(["cus-a", "cus-b", "cus-c", "cus-d", "cus-e"]);
    }
  });

  it("reports a customer_id with no row as unavailable rather than unassigned", async () => {
    listWithCounts.mockResolvedValue(
      ok({
        items: [
          {
            ...ROW,
            profiles: [
              /* customer_id set, join returned nothing. */
              {
                ...profile(1, customerRow("cus-gone", "663947116")),
                customer: null,
              },
            ],
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
      }),
    );

    const result = await accountsService.listAccounts({ limit: 25, offset: 0 });

    if (result.ok) {
      expect(result.value.items[0]?.profiles[0]?.customer.kind).toBe("unavailable");
    }
  });

  it("leaves an unsold slot with no customer", async () => {
    const result = await accountsService.listAccounts({ limit: 25, offset: 0 });

    if (result.ok) {
      expect(result.value.items[0]?.profiles.every((p) => p.customer.kind === "none")).toBe(true);
    }
  });
});
