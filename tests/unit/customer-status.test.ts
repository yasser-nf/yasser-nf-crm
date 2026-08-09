import { describe, expect, it } from "vitest";

import {
  deriveCustomerStatus,
  expiryUrgency,
  isSubscriptionActive,
  remainingDays,
} from "@/modules/customers/services/customer-status";

/**
 * Customer status and expiry tests.
 *
 * M05 requires status to be computed rather than stored. These fix the
 * derivation, so a later change that quietly starts storing it fails here.
 */

const TODAY = new Date("2026-08-09T12:00:00Z");

const notBlocked = { blockedAt: null, deletedAt: null };

describe("remainingDays", () => {
  const cases: [string, number][] = [
    ["2026-08-09", 0],
    ["2026-08-10", 1],
    ["2026-08-12", 3],
    ["2026-08-08", -1],
    ["2026-07-09", -31],
    ["2026-09-09", 31],
    ["2027-08-09", 365],
  ];

  for (const [date, expected] of cases) {
    it(`${date} is ${expected} days away`, () => {
      expect(remainingDays(date, TODAY)).toBe(expected);
    });
  }

  it("returns null with no expiry", () => {
    expect(remainingDays(null, TODAY)).toBeNull();
  });

  it("returns null for an unparseable date rather than NaN", () => {
    expect(remainingDays("not-a-date", TODAY)).toBeNull();
  });

  it("does not shift with the time of day", () => {
    const morning = remainingDays("2026-08-12", new Date("2026-08-09T00:30:00Z"));
    const night = remainingDays("2026-08-12", new Date("2026-08-09T23:30:00Z"));
    expect(morning).toBe(night);
  });
});

describe("expiryUrgency", () => {
  const cases: [string | null, string][] = [
    ["2026-08-01", "expired"],
    ["2026-08-08", "expired"],
    ["2026-08-09", "today"],
    ["2026-08-10", "tomorrow"],
    ["2026-08-11", "soon"],
    ["2026-08-12", "soon"],
    ["2026-08-13", "later"],
    ["2026-12-01", "later"],
    [null, "none"],
  ];

  for (const [date, expected] of cases) {
    it(`${date ?? "no expiry"} is "${expected}"`, () => {
      expect(expiryUrgency(date, TODAY)).toBe(expected);
    });
  }

  it("treats the three-day window as inclusive", () => {
    expect(expiryUrgency("2026-08-12", TODAY)).toBe("soon");
    expect(expiryUrgency("2026-08-13", TODAY)).toBe("later");
  });
});

describe("isSubscriptionActive", () => {
  it("is active when sold and not yet expired", () => {
    expect(isSubscriptionActive({ status: "sold", expirationDate: "2026-08-20" }, TODAY)).toBe(
      true,
    );
  });

  it("is active on the final day", () => {
    expect(isSubscriptionActive({ status: "sold", expirationDate: "2026-08-09" }, TODAY)).toBe(
      true,
    );
  });

  it("is inactive the day after expiry", () => {
    expect(isSubscriptionActive({ status: "sold", expirationDate: "2026-08-08" }, TODAY)).toBe(
      false,
    );
  });

  it("treats a missing expiry as open-ended, not expired", () => {
    expect(isSubscriptionActive({ status: "sold", expirationDate: null }, TODAY)).toBe(true);
  });

  it("counts expiring_soon as still serving the customer", () => {
    expect(
      isSubscriptionActive({ status: "expiring_soon", expirationDate: "2026-08-10" }, TODAY),
    ).toBe(true);
  });

  it("is inactive for available, reserved and expired profiles", () => {
    for (const status of ["available", "reserved", "expired"]) {
      expect(isSubscriptionActive({ status, expirationDate: "2026-12-01" }, TODAY)).toBe(false);
    }
  });
});

describe("deriveCustomerStatus", () => {
  it("is active while holding a live subscription", () => {
    expect(
      deriveCustomerStatus(notBlocked, [{ status: "sold", expirationDate: "2026-09-01" }], TODAY),
    ).toBe("active");
  });

  it("is inactive with no subscriptions", () => {
    expect(deriveCustomerStatus(notBlocked, [], TODAY)).toBe("inactive");
  });

  it("is inactive once every subscription has expired", () => {
    expect(
      deriveCustomerStatus(notBlocked, [{ status: "sold", expirationDate: "2026-01-01" }], TODAY),
    ).toBe("inactive");
  });

  it("is active if any one subscription is live", () => {
    expect(
      deriveCustomerStatus(
        notBlocked,
        [
          { status: "sold", expirationDate: "2026-01-01" },
          { status: "sold", expirationDate: "2026-12-01" },
        ],
        TODAY,
      ),
    ).toBe("active");
  });

  it("blocked outranks an active subscription", () => {
    expect(
      deriveCustomerStatus(
        { blockedAt: new Date("2026-08-01"), deletedAt: null },
        [{ status: "sold", expirationDate: "2026-12-01" }],
        TODAY,
      ),
    ).toBe("blocked");
  });

  it("archived outranks blocked", () => {
    expect(
      deriveCustomerStatus(
        { blockedAt: new Date("2026-08-01"), deletedAt: new Date("2026-08-05") },
        [],
        TODAY,
      ),
    ).toBe("archived");
  });

  it("archived outranks an active subscription", () => {
    expect(
      deriveCustomerStatus(
        { blockedAt: null, deletedAt: new Date("2026-08-05") },
        [{ status: "sold", expirationDate: "2026-12-01" }],
        TODAY,
      ),
    ).toBe("archived");
  });
});
