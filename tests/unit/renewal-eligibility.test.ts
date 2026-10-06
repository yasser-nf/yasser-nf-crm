import { describe, expect, it } from "vitest";

import { renewalBlockedReason } from "@/modules/quick-renew";
import type { AccountRow, CustomerRow, ProfileRow } from "@/lib/drizzle/schema";

/**
 * Who may be renewed, and why not. M09 §14.
 *
 * Every rule asserted here is an EXISTING rule being applied, and the test
 * names the rule rather than the branch. The most important assertion in the
 * file is the negative one at the end: an EXPIRED subscription is renewable.
 * Refusing one would be the invented restriction §14 forbids, and it is the
 * easiest mistake to make from the Quick Replace code — which refuses exactly
 * that case, for a reason that does not apply here.
 */

const today = new Date("2026-10-01T12:00:00Z");

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "acc-1",
    email: "stock@example.invalid",
    passwordEncrypted: "v1:a:b:c",
    status: "healthy",
    country: "DZ",
    notes: null,
    profileSlots: 5,
    validFrom: null,
    validUntil: null,
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
    id: "pro-1",
    accountId: "acc-1",
    profileNumber: 2,
    profileName: "Profile 2",
    pin: null,
    status: "sold",
    customerId: "cus-1",
    workerId: null,
    saleDate: "2026-09-20",
    expirationDate: "2026-10-20",
    durationDays: 30,
    notes: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as ProfileRow;
}

function customer(overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: "cus-1",
    name: null,
    phoneOriginal: "0663947116",
    phoneNormalized: "663947116",
    whatsappUrl: "https://wa.me/213663947116",
    notes: null,
    firstPurchaseAt: null,
    lastPurchaseAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    deletedAt: null,
    blockedAt: null,
    ...overrides,
  } as CustomerRow;
}

const base = {
  account: account(),
  profile: profile(),
  hasActiveProblem: false,
  customer: customer(),
};

describe("a renewable subscription", () => {
  it("is allowed on a healthy account with a live customer", () => {
    expect(renewalBlockedReason(base, today)).toBeNull();
  });

  it("is allowed when the allocation has EXPIRED", () => {
    /*
     * The rule M09 §9 depends on. An expired profile is stock again
     * (03_DATABASE.md), and selling it back to the same customer is a renewal
     * starting today — not something to refuse.
     */
    expect(
      renewalBlockedReason({ ...base, profile: profile({ expirationDate: "2026-01-01" }) }, today),
    ).toBeNull();
  });

  it("is allowed on the account's highest sellable slot", () => {
    expect(
      renewalBlockedReason(
        { ...base, account: account({ profileSlots: 2 }), profile: profile({ profileNumber: 2 }) },
        today,
      ),
    ).toBeNull();
  });
});

describe("the account's state overrides everything about the slot", () => {
  it.each([
    ["payment_problem"],
    ["incorrect_password"],
    ["invalid_email"],
    ["something_went_wrong"],
    ["archived"],
    ["deleted"],
  ])("refuses a %s account", (status) => {
    expect(
      renewalBlockedReason(
        { ...base, account: account({ status: status as AccountRow["status"] }) },
        today,
      ),
    ).toBe("account_unavailable");
  });

  it("refuses an account with a blocking problem open", () => {
    expect(renewalBlockedReason({ ...base, hasActiveProblem: true }, today)).toBe(
      "account_unavailable",
    );
  });

  it("refuses a soft-deleted account", () => {
    expect(
      renewalBlockedReason(
        { ...base, account: account({ deletedAt: new Date("2026-05-01") }) },
        today,
      ),
    ).toBe("account_unavailable");
  });

  it("refuses an account whose own validity has run out", () => {
    expect(
      renewalBlockedReason({ ...base, account: account({ validUntil: "2026-09-01" }) }, today),
    ).toBe("account_unavailable");
  });

  it("allows an account whose validity is open-ended", () => {
    expect(
      renewalBlockedReason({ ...base, account: account({ validUntil: null }) }, today),
    ).toBeNull();
  });

  it("reports the ACCOUNT even when the slot is also unsellable", () => {
    /* Precedence, and it is the rule: fix the account first. */
    expect(
      renewalBlockedReason(
        {
          ...base,
          account: account({ status: "payment_problem", profileSlots: 1 }),
          profile: profile({ profileNumber: 4 }),
        },
        today,
      ),
    ).toBe("account_unavailable");
  });
});

describe("the slot", () => {
  it("refuses a slot above the account's sellable count", () => {
    expect(renewalBlockedReason({ ...base, account: account({ profileSlots: 1 }) }, today)).toBe(
      "slot_not_for_sale",
    );
  });
});

describe("the customer", () => {
  it("refuses a slot nobody holds", () => {
    expect(
      renewalBlockedReason(
        {
          ...base,
          profile: profile({ customerId: null, status: "available", expirationDate: null }),
          customer: null,
        },
        today,
      ),
    ).toBe("no_customer");
  });

  it("refuses when the customer record is gone", () => {
    expect(renewalBlockedReason({ ...base, customer: null }, today)).toBe("no_customer");
  });

  it("refuses a blocked customer", () => {
    expect(
      renewalBlockedReason(
        { ...base, customer: customer({ blockedAt: new Date("2026-06-01") }) },
        today,
      ),
    ).toBe("customer_blocked");
  });

  it("refuses an archived customer, and says archived rather than blocked", () => {
    expect(
      renewalBlockedReason(
        {
          ...base,
          customer: customer({
            deletedAt: new Date("2026-06-01"),
            blockedAt: new Date("2026-06-01"),
          }),
        },
        today,
      ),
    ).toBe("customer_archived");
  });
});
