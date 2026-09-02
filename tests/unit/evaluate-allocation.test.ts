import { describe, expect, it } from "vitest";

import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";
import { evaluateAllocation } from "@/modules/accounts";

/**
 * The single allocation rule.
 *
 * `evaluateAllocation` is the one function Quick Prepare, Quick Replace, the
 * accounts screen and the dashboard all call. M13 §11 requires the business
 * rules to be enforced centrally rather than duplicated across components, so
 * this file is where "centrally" is actually verified.
 *
 * The order of the checks is itself a business rule and is asserted: the reason
 * a worker is shown must be the one they can act on.
 */

const TODAY = new Date("2026-08-12T09:30:00Z");

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: "stock@example.com",
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
  };
}

function profile(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    accountId: "11111111-1111-4111-8111-111111111111",
    profileNumber: 1,
    profileName: null,
    pin: "1234",
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
  };
}

describe("the pre-M13 rules still hold", () => {
  it("allows a free profile on a healthy account", () => {
    const result = evaluateAllocation(account(), profile(), { today: TODAY });

    expect(result.isAllocatable).toBe(true);
    expect(result.blockedReason).toBeNull();
  });

  it("blocks every profile on an unhealthy account", () => {
    /* 01_MASTER_RULES.md: no exceptions, regardless of the profile's own status. */
    for (const status of [
      "payment_problem",
      "incorrect_password",
      "invalid_email",
      "something_went_wrong",
      "archived",
    ] as const) {
      const result = evaluateAllocation(account({ status }), profile(), { today: TODAY });

      expect(result.isAllocatable, status).toBe(false);
      expect(result.blockedReason).toBe("account_not_healthy");
    }
  });

  it("blocks when an open problem exists", () => {
    const result = evaluateAllocation(account(), profile(), {
      hasActiveProblem: true,
      today: TODAY,
    });

    expect(result.blockedReason).toBe("account_has_problem");
  });

  it("reports the status before the problem when both are wrong", () => {
    /* The more specific reason wins — status is what a worker can act on. */
    const result = evaluateAllocation(account({ status: "payment_problem" }), profile(), {
      hasActiveProblem: true,
      today: TODAY,
    });

    expect(result.blockedReason).toBe("account_not_healthy");
  });
});

describe("account validity", () => {
  it("blocks an account whose own coverage has run out", () => {
    const result = evaluateAllocation(account({ validUntil: "2026-08-01" }), profile(), {
      today: TODAY,
    });

    expect(result.isAllocatable).toBe(false);
    expect(result.blockedReason).toBe("account_expired");
  });

  it("still allows an account on its final day", () => {
    const result = evaluateAllocation(account({ validUntil: "2026-08-12" }), profile(), {
      today: TODAY,
    });

    expect(result.isAllocatable).toBe(true);
  });

  it("blocks when the requested duration exceeds what remains", () => {
    const result = evaluateAllocation(account({ validUntil: "2026-08-30" }), profile(), {
      requestedDurationDays: 90,
      today: TODAY,
    });

    expect(result.isAllocatable).toBe(false);
    expect(result.blockedReason).toBe("insufficient_account_validity");
  });

  it("reports both numbers so the UI can explain the refusal", () => {
    /*
     * The M13 Phase B requirement verbatim: the UI must be able to render
     * "Only 18 days remaining. Customer requested 90 days."
     */
    const result = evaluateAllocation(account({ validUntil: "2026-08-30" }), profile(), {
      requestedDurationDays: 90,
      today: TODAY,
    });

    expect(result.validity.remainingDays).toBe(18);
    expect(result.validity.requestedDays).toBe(90);
  });

  it("carries the validity numbers on a SUCCESSFUL evaluation too", () => {
    /* So a screen can show remaining validity while things are still fine. */
    const result = evaluateAllocation(account({ validUntil: "2026-12-31" }), profile(), {
      requestedDurationDays: 30,
      today: TODAY,
    });

    expect(result.isAllocatable).toBe(true);
    expect(result.validity.remainingDays).toBe(141);
    expect(result.validity.requestedDays).toBe(30);
  });

  it("never blocks for duration when no duration was asked for", () => {
    /*
     * The account detail screen has no duration in hand. Marking a free profile
     * blocked against a number nobody entered would be a lie.
     */
    const result = evaluateAllocation(account({ validUntil: "2026-08-13" }), profile(), {
      today: TODAY,
    });

    expect(result.isAllocatable).toBe(true);
    expect(result.validity.requestedDays).toBeNull();
  });

  it("lets an open-ended account cover the longest duration allowed", () => {
    const result = evaluateAllocation(account(), profile(), {
      requestedDurationDays: 730,
      today: TODAY,
    });

    expect(result.isAllocatable).toBe(true);
    expect(result.validity.remainingDays).toBeNull();
  });
});

describe("sellable slots", () => {
  it("blocks a profile above the account's slot count", () => {
    const result = evaluateAllocation(account({ profileSlots: 3 }), profile({ profileNumber: 4 }), {
      today: TODAY,
    });

    expect(result.isAllocatable).toBe(false);
    expect(result.blockedReason).toBe("profile_not_for_sale");
  });

  it("allows the last sellable slot", () => {
    const result = evaluateAllocation(account({ profileSlots: 3 }), profile({ profileNumber: 3 }), {
      today: TODAY,
    });

    expect(result.isAllocatable).toBe(true);
  });

  it("distinguishes not-for-sale from merely unavailable", () => {
    /*
     * Two different answers for two different situations: one waits for an
     * expiry, the other never becomes stock at all.
     */
    /*
     * The parked slot is still `available` at the column level — sellability is
     * derived, not stored — so this asserts the derivation actually happens.
     */
    const notForSale = evaluateAllocation(
      account({ profileSlots: 1 }),
      profile({ profileNumber: 2, status: "available" }),
      { today: TODAY },
    );

    const sold = evaluateAllocation(
      account(),
      profile({ profileNumber: 2, status: "sold", expirationDate: "2026-12-01" }),
      { today: TODAY },
    );

    expect(notForSale.blockedReason).toBe("profile_not_for_sale");
    expect(sold.blockedReason).toBe("profile_not_available");
  });
});

describe("expired allocations return to stock", () => {
  it("allocates a sold profile whose customer has expired", () => {
    /*
     * 03_DATABASE.md has required this since M02 and nothing implemented it.
     * The profile still reads `sold` — the date is the authority, not the status.
     */
    const lapsed = profile({ status: "sold", expirationDate: "2026-08-01" });
    const result = evaluateAllocation(account(), lapsed, { today: TODAY });

    expect(result.isAllocatable).toBe(true);
    expect(result.profile.status).toBe("sold");
  });

  it("does not free a profile on its final day", () => {
    const lastDay = profile({ status: "sold", expirationDate: "2026-08-12" });
    expect(evaluateAllocation(account(), lastDay, { today: TODAY }).isAllocatable).toBe(false);
  });

  it("refuses to recycle an expired allocation on an unhealthy account", () => {
    /* The rule is conditional on the account being healthy. */
    const lapsed = profile({ status: "sold", expirationDate: "2026-08-01" });
    const result = evaluateAllocation(account({ status: "payment_problem" }), lapsed, {
      today: TODAY,
    });

    expect(result.isAllocatable).toBe(false);
    expect(result.blockedReason).toBe("account_not_healthy");
  });

  it("refuses to recycle a lapsed profile in a non-sellable slot", () => {
    /* Expiry does not promote a profile into stock it was never part of. */
    const lapsed = profile({
      profileNumber: 5,
      status: "sold",
      expirationDate: "2026-08-01",
    });

    const result = evaluateAllocation(account({ profileSlots: 2 }), lapsed, { today: TODAY });

    expect(result.blockedReason).toBe("profile_not_for_sale");
  });
});

describe("check order", () => {
  it("names the account before the profile when both are wrong", () => {
    /*
     * An expired account cannot serve anyone. Sending a worker to look at the
     * profile would waste their time on a symptom.
     */
    const result = evaluateAllocation(
      account({ validUntil: "2026-01-01", profileSlots: 1 }),
      profile({ profileNumber: 5 }),
      { today: TODAY },
    );

    expect(result.blockedReason).toBe("account_expired");
  });

  it("names the slot before the duration", () => {
    /* A slot that is not stock cannot be fixed by shortening the subscription. */
    const result = evaluateAllocation(
      account({ profileSlots: 1, validUntil: "2026-08-20" }),
      profile({ profileNumber: 4 }),
      { requestedDurationDays: 365, today: TODAY },
    );

    expect(result.blockedReason).toBe("profile_not_for_sale");
  });
});
