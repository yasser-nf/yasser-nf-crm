import { describe, expect, it } from "vitest";

import { addMonthsToDateString, daysBetweenDateStrings } from "@/lib/dates";
import {
  MAX_RENEWAL_DAYS,
  applyDuration,
  describeDuration,
  planRenewal,
  renewalBase,
} from "@/modules/quick-renew";
import { confirmRenewalSchema, renewalDurationSchema } from "@/modules/quick-renew";

/**
 * M09A renewal arithmetic and policy, without a database.
 *
 * The two rules that are business decisions rather than arithmetic — a
 * calendar month is not thirty days, and a lapsed subscription restarts from
 * today — are pinned here, because both are invisible in a diff once they are
 * right and expensive to get wrong in production.
 */

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("calendar months", () => {
  it("adds a real month, not thirty days", () => {
    expect(addMonthsToDateString("2026-01-01", 1)).toBe("2026-02-01");
    expect(addMonthsToDateString("2026-03-15", 1)).toBe("2026-04-15");
    /* Thirty days from 1 March would be 31 March; one month is 1 April. */
    expect(addMonthsToDateString("2026-03-01", 1)).toBe("2026-04-01");
  });

  it("clamps a month end instead of rolling into the next month", () => {
    /* The naive setUTCMonth form returns 3 March here, handing out three free days. */
    expect(addMonthsToDateString("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsToDateString("2026-01-30", 1)).toBe("2026-02-28");
    expect(addMonthsToDateString("2026-03-31", 1)).toBe("2026-04-30");
    expect(addMonthsToDateString("2026-05-31", 1)).toBe("2026-06-30");
    expect(addMonthsToDateString("2026-08-31", 6)).toBe("2027-02-28");
  });

  it("uses 29 February in a leap year", () => {
    expect(addMonthsToDateString("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonthsToDateString("2024-02-29", 12)).toBe("2025-02-28");
    expect(addMonthsToDateString("2023-02-28", 12)).toBe("2024-02-28");
  });

  it("rolls the year, and keeps a day that exists in the target month", () => {
    expect(addMonthsToDateString("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonthsToDateString("2026-07-15", 12)).toBe("2027-07-15");
    expect(addMonthsToDateString("2026-11-30", 3)).toBe("2027-02-28");
  });

  it("refuses a date it cannot parse, and a fractional month count", () => {
    expect(addMonthsToDateString(null, 1)).toBeNull();
    expect(addMonthsToDateString("not-a-date", 1)).toBeNull();
    expect(addMonthsToDateString("", 1)).toBeNull();
    expect(addMonthsToDateString("2026-01-01", 1.5)).toBeNull();
  });

  it("inherits parseDateString's roll-over for a day that does not exist", () => {
    /*
     * `Date.parse("2026-02-30T00:00:00Z")` is 2 March, not NaN — the existing
     * behaviour of `parseDateString`, which every date helper here shares.
     * Pinned rather than fixed: a `date` column and an `<input type="date">`
     * cannot produce such a value, so changing it would alter the whole
     * library's contract for a string this feature never receives.
     */
    expect(addMonthsToDateString("2026-02-30", 1)).toBe("2026-04-02");
  });

  it("measures whole days between two dates, including across a leap day", () => {
    expect(daysBetweenDateStrings("2026-01-01", "2026-01-31")).toBe(30);
    expect(daysBetweenDateStrings("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetweenDateStrings("2026-03-01", "2026-02-01")).toBe(-28);
    expect(daysBetweenDateStrings(null, "2026-01-01")).toBeNull();
  });
});

describe("where a renewal starts", () => {
  const now = at("2026-06-17");

  it("continues from the existing expiry while the subscription is running", () => {
    expect(renewalBase("2026-07-01", now)).toEqual({ basis: "continues", from: "2026-07-01" });
    /* Expiring today is not expired: the customer still has the day. */
    expect(renewalBase("2026-06-17", now)).toEqual({ basis: "continues", from: "2026-06-17" });
  });

  it("restarts from today once the subscription has lapsed", () => {
    expect(renewalBase("2026-06-16", now)).toEqual({ basis: "restarts", from: "2026-06-17" });
    expect(renewalBase("2025-01-01", now)).toEqual({ basis: "restarts", from: "2026-06-17" });
  });

  it("has no answer without an expiry", () => {
    expect(renewalBase(null, now)).toBeNull();
  });
});

describe("the whole plan", () => {
  const now = at("2026-06-17");

  it("extends a running subscription and restates the duration from the sale date", () => {
    const plan = planRenewal({
      saleDate: "2026-01-17",
      currentExpiration: "2026-07-17",
      duration: { unit: "months", months: 3 },
      now,
    });

    expect(plan).toMatchObject({
      basis: "continues",
      currentExpiration: "2026-07-17",
      newExpiration: "2026-10-17",
      daysAdded: 92,
    });
    /* sale date + duration must still equal the expiry — profile-dates.ts derives it. */
    expect(plan?.durationDays).toBe(daysBetweenDateStrings("2026-01-17", "2026-10-17"));
    expect(daysBetweenDateStrings("2026-01-17", plan!.newExpiration)).toBe(plan!.durationDays);
  });

  it("restarts a lapsed subscription from today, and says so", () => {
    const plan = planRenewal({
      saleDate: "2025-11-01",
      currentExpiration: "2026-02-01",
      duration: { unit: "months", months: 1 },
      now,
    });

    expect(plan).toMatchObject({
      basis: "restarts",
      currentExpiration: "2026-02-01",
      newExpiration: "2026-07-17",
    });
    expect(plan!.durationDays).toBe(daysBetweenDateStrings("2025-11-01", "2026-07-17"));
  });

  it("keeps the invariant for a custom day count", () => {
    const plan = planRenewal({
      saleDate: "2026-06-01",
      currentExpiration: "2026-06-30",
      duration: { unit: "days", days: 45 },
      now,
    });

    expect(plan?.newExpiration).toBe("2026-08-14");
    expect(plan?.daysAdded).toBe(45);
    expect(plan?.durationDays).toBe(daysBetweenDateStrings("2026-06-01", "2026-08-14"));
  });

  it("returns no plan without an expiry, and no duration without a sale date", () => {
    expect(
      planRenewal({
        saleDate: "2026-01-01",
        currentExpiration: null,
        duration: { unit: "months", months: 1 },
        now,
      }),
    ).toBeNull();

    const noSale = planRenewal({
      saleDate: null,
      currentExpiration: "2026-07-01",
      duration: { unit: "months", months: 1 },
      now,
    });
    expect(noSale?.newExpiration).toBe("2026-08-01");
    expect(noSale?.durationDays).toBeNull();
  });

  it("a month-end renewal clamps rather than drifting", () => {
    const plan = planRenewal({
      saleDate: "2026-01-31",
      currentExpiration: "2026-01-31",
      duration: { unit: "months", months: 1 },
      now: at("2026-01-20"),
    });

    expect(plan?.newExpiration).toBe("2026-02-28");
  });
});

describe("duration wording and validation", () => {
  it("names each period the way the operator picked it", () => {
    expect(describeDuration({ unit: "months", months: 1 })).toBe("1 month");
    expect(describeDuration({ unit: "months", months: 3 })).toBe("3 months");
    expect(describeDuration({ unit: "months", months: 12 })).toBe("1 year");
    expect(describeDuration({ unit: "days", days: 1 })).toBe("1 day");
    expect(describeDuration({ unit: "days", days: 45 })).toBe("45 days");
  });

  it("accepts only the offered months and a sane day count", () => {
    for (const months of [1, 2, 3, 6, 12]) {
      expect(renewalDurationSchema.safeParse({ unit: "months", months }).success).toBe(true);
    }
    for (const months of [0, 4, 5, 13, 24, -1]) {
      expect(renewalDurationSchema.safeParse({ unit: "months", months }).success).toBe(false);
    }

    expect(renewalDurationSchema.safeParse({ unit: "days", days: 1 }).success).toBe(true);
    expect(renewalDurationSchema.safeParse({ unit: "days", days: MAX_RENEWAL_DAYS }).success).toBe(
      true,
    );
    for (const days of [0, -5, 1.5, MAX_RENEWAL_DAYS + 1]) {
      expect(renewalDurationSchema.safeParse({ unit: "days", days }).success).toBe(false);
    }
  });

  it("requires the previewed expiry on a confirmation", () => {
    const base = {
      profileId: "aaaaaaaa-0000-4000-8000-000000000001",
      duration: { unit: "months", months: 1 },
    };

    expect(confirmRenewalSchema.safeParse(base).success).toBe(false);
    expect(
      confirmRenewalSchema.safeParse({ ...base, expectedExpirationDate: "not-a-date" }).success,
    ).toBe(false);
    expect(
      confirmRenewalSchema.safeParse({ ...base, expectedExpirationDate: "2026-07-01" }).success,
    ).toBe(true);
  });
});

describe("applyDuration", () => {
  it("uses calendar months for months and whole days for days", () => {
    expect(applyDuration("2026-01-31", { unit: "months", months: 1 })).toBe("2026-02-28");
    expect(applyDuration("2026-01-31", { unit: "days", days: 28 })).toBe("2026-02-28");
    expect(applyDuration("2026-01-31", { unit: "days", days: 30 })).toBe("2026-03-02");
  });
});
