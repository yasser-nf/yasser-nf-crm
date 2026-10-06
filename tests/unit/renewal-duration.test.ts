import { describe, expect, it } from "vitest";

import { addMonths, addMonthsToDateString, daysBetween } from "@/lib/dates";
import {
  RENEWAL_PRESETS,
  presetById,
  quoteRenewal,
  renewalBasis,
  renewalLabel,
  type RenewalDuration,
} from "@/modules/quick-renew";

/**
 * Renewal date arithmetic. M09 §9.
 *
 * The rule under test is the one the milestone exists for: a LIVE subscription
 * extends from its current expiry, never from today, so renewing early costs
 * the customer nothing. The second rule is its complement: a LAPSED one starts
 * today, because there is nothing left to carry over.
 *
 * Everything here is pure and takes its clock as an argument, so the boundary
 * cases — expiring today, month ends, leap days — are tested at the dates they
 * happen rather than whenever the suite runs.
 */

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

const preset = (id: string): RenewalDuration => ({ kind: "preset", preset: id }) as RenewalDuration;

const custom = (days: number): RenewalDuration => ({ kind: "custom", days });

/** A live subscription: sold 20 September for 30 days, expiring 20 October. */
const live = { saleDate: "2026-09-20", expirationDate: "2026-10-20" } as const;

describe("addMonths — calendar months, not 30 days", () => {
  it("keeps the day of the month", () => {
    expect(addMonths(at("2026-10-20"), 1)).toBe("2026-11-20");
    expect(addMonths(at("2026-10-20"), 3)).toBe("2027-01-20");
    expect(addMonths(at("2026-10-20"), 12)).toBe("2027-10-20");
  });

  it("clamps to the last day when the target month is shorter", () => {
    /* No 31 February exists; rolling forward would give 3 March. */
    expect(addMonths(at("2026-01-31"), 1)).toBe("2026-02-28");
    expect(addMonths(at("2028-01-31"), 1)).toBe("2028-02-29");
    expect(addMonths(at("2026-08-31"), 1)).toBe("2026-09-30");
  });

  it("crosses a year boundary", () => {
    expect(addMonths(at("2026-12-15"), 1)).toBe("2027-01-15");
    expect(addMonths(at("2026-11-30"), 6)).toBe("2027-05-30");
  });

  it("handles a leap day", () => {
    expect(addMonths(at("2028-02-29"), 12)).toBe("2029-02-28");
    expect(addMonths(at("2028-02-29"), 1)).toBe("2028-03-29");
  });

  it("works on strings and refuses nonsense", () => {
    expect(addMonthsToDateString("2026-10-20", 2)).toBe("2026-12-20");
    expect(addMonthsToDateString(null, 2)).toBeNull();
    expect(addMonthsToDateString("not-a-date", 2)).toBeNull();
  });
});

describe("daysBetween", () => {
  it("counts whole days forward and back", () => {
    expect(daysBetween("2026-10-20", "2026-11-19")).toBe(30);
    expect(daysBetween("2026-10-20", "2026-10-20")).toBe(0);
    expect(daysBetween("2026-11-19", "2026-10-20")).toBe(-30);
  });

  it("spans a leap day", () => {
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetween("2027-02-28", "2027-03-01")).toBe(1);
  });

  it("is null when either side is absent", () => {
    expect(daysBetween(null, "2026-10-20")).toBeNull();
    expect(daysBetween("2026-10-20", null)).toBeNull();
  });
});

describe("renewalBasis", () => {
  it("extends a subscription that is still running", () => {
    expect(renewalBasis("2026-10-20", at("2026-10-01"))).toBe("current_expiry");
  });

  it("treats expiring TODAY as still running — the day was paid for", () => {
    expect(renewalBasis("2026-10-20", at("2026-10-20"))).toBe("current_expiry");
  });

  it("restarts one that has lapsed", () => {
    expect(renewalBasis("2026-10-20", at("2026-10-21"))).toBe("today");
    expect(renewalBasis("2026-01-01", at("2026-10-01"))).toBe("today");
  });

  it("restarts one with no expiry at all — there is no boundary to extend", () => {
    expect(renewalBasis(null, at("2026-10-01"))).toBe("today");
  });
});

describe("an active subscription extends from its current expiry", () => {
  it("adds 30 custom days to the expiry, not to today", () => {
    const quote = quoteRenewal(live, custom(30), at("2026-10-01"));

    expect(quote?.basis).toBe("current_expiry");
    expect(quote?.baseDate).toBe("2026-10-20");
    /* 20 October + 30 days. October has 31 days, so this lands on 19 November. */
    expect(quote?.expirationDate).toBe("2026-11-19");
    expect(quote?.addedDays).toBe(30);
  });

  it("adds 90 days", () => {
    const quote = quoteRenewal(live, custom(90), at("2026-10-01"));

    expect(quote?.expirationDate).toBe("2027-01-18");
    expect(quote?.addedDays).toBe(90);
  });

  it("adds 365 days", () => {
    const quote = quoteRenewal(live, custom(365), at("2026-10-01"));

    expect(quote?.expirationDate).toBe("2027-10-20");
    expect(quote?.addedDays).toBe(365);
  });

  it("gives the same answer whenever in the window it is renewed", () => {
    const early = quoteRenewal(live, preset("3_months"), at("2026-09-21"));
    const late = quoteRenewal(live, preset("3_months"), at("2026-10-20"));

    /* The whole point: renewing early must not shorten the renewal. */
    expect(early?.expirationDate).toBe("2027-01-20");
    expect(late?.expirationDate).toBe("2027-01-20");
  });

  it("keeps the original sale date and makes duration the whole span", () => {
    const quote = quoteRenewal(live, preset("1_month"), at("2026-10-01"));

    expect(quote?.saleDate).toBe("2026-09-20");
    expect(quote?.expirationDate).toBe("2026-11-20");
    /*
     * 20 September to 20 November. `expiration = sale_date + duration_days` is
     * the invariant profile-dates.ts owns, so the duration must be the whole
     * span rather than the renewal length — otherwise the profile editor would
     * re-derive a different expiry on the next unrelated save.
     */
    expect(quote?.durationDays).toBe(61);
    expect(daysBetween(quote?.saleDate ?? null, quote?.expirationDate ?? null)).toBe(
      quote?.durationDays,
    );
  });

  it("extends on the last day of the window", () => {
    const quote = quoteRenewal(live, custom(30), at("2026-10-20"));

    expect(quote?.basis).toBe("current_expiry");
    expect(quote?.expirationDate).toBe("2026-11-19");
  });
});

describe("every preset", () => {
  it("offers exactly the five lengths M09 §8 lists", () => {
    expect(RENEWAL_PRESETS.map((entry) => entry.label)).toEqual([
      "1 month",
      "2 months",
      "3 months",
      "6 months",
      "1 year",
    ]);
  });

  it.each([
    ["1_month", "2026-11-20"],
    ["2_months", "2026-12-20"],
    ["3_months", "2027-01-20"],
    ["6_months", "2027-04-20"],
    ["1_year", "2027-10-20"],
  ])("%s lands on %s", (id, expected) => {
    expect(quoteRenewal(live, preset(id), at("2026-10-01"))?.expirationDate).toBe(expected);
  });

  it("names a length the same way everywhere", () => {
    expect(renewalLabel(preset("3_months"))).toBe("3 months");
    expect(renewalLabel(custom(45))).toBe("45 days");
    expect(renewalLabel(custom(1))).toBe("1 day");
  });

  it("resolves a preset by id, and nothing else", () => {
    expect(presetById("6_months")?.months).toBe(6);
    expect(presetById("18_months")).toBeNull();
  });

  it("clamps a month-end subscription rather than crossing into the next month", () => {
    const monthEnd = { saleDate: "2025-12-31", expirationDate: "2026-01-31" } as const;

    expect(quoteRenewal(monthEnd, preset("1_month"), at("2026-01-05"))?.expirationDate).toBe(
      "2026-02-28",
    );
  });

  it("renews across a leap day", () => {
    const beforeLeap = { saleDate: "2028-01-29", expirationDate: "2028-01-29" } as const;

    expect(quoteRenewal(beforeLeap, preset("1_month"), at("2028-01-29"))?.expirationDate).toBe(
      "2028-02-29",
    );
  });
});

describe("an expired subscription starts a new term today", () => {
  const lapsed = { saleDate: "2026-01-01", expirationDate: "2026-01-31" } as const;

  it("counts from today, never from the lapsed date", () => {
    const quote = quoteRenewal(lapsed, custom(30), at("2026-10-01"));

    expect(quote?.basis).toBe("today");
    expect(quote?.baseDate).toBe("2026-10-01");
    expect(quote?.expirationDate).toBe("2026-10-31");
    expect(quote?.addedDays).toBe(30);
  });

  it("moves the sale date to today, so the term is the renewal length", () => {
    const quote = quoteRenewal(lapsed, preset("1_month"), at("2026-10-01"));

    expect(quote?.saleDate).toBe("2026-10-01");
    expect(quote?.expirationDate).toBe("2026-11-01");
    expect(quote?.durationDays).toBe(31);
  });

  it("reports the expiry it replaced, so history can show it", () => {
    expect(quoteRenewal(lapsed, custom(30), at("2026-10-01"))?.previousExpirationDate).toBe(
      "2026-01-31",
    );
  });

  it("restarts a subscription that lapsed yesterday", () => {
    const quote = quoteRenewal(
      { saleDate: "2026-09-01", expirationDate: "2026-09-30" },
      custom(30),
      at("2026-10-01"),
    );

    expect(quote?.basis).toBe("today");
    expect(quote?.expirationDate).toBe("2026-10-31");
  });
});

describe("a subscription with no recorded dates", () => {
  it("starts today when there is no expiry to extend", () => {
    const quote = quoteRenewal(
      { saleDate: null, expirationDate: null },
      custom(30),
      at("2026-10-01"),
    );

    expect(quote?.basis).toBe("today");
    expect(quote?.saleDate).toBe("2026-10-01");
    expect(quote?.expirationDate).toBe("2026-10-31");
    expect(quote?.previousExpirationDate).toBeNull();
  });

  it("extends a live expiry even with no sale date, using today as the start", () => {
    const quote = quoteRenewal(
      { saleDate: null, expirationDate: "2026-10-20" },
      custom(10),
      at("2026-10-01"),
    );

    expect(quote?.basis).toBe("current_expiry");
    expect(quote?.expirationDate).toBe("2026-10-30");
    expect(quote?.saleDate).toBe("2026-10-01");
    expect(quote?.durationDays).toBe(29);
  });
});

describe("a quote that is not a renewal", () => {
  it.each([[0], [-1], [-30], [0.5], [30.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "refuses %s custom days",
    (days) => {
      expect(quoteRenewal(live, custom(days), at("2026-10-01"))).toBeNull();
    },
  );

  it("refuses an unknown preset rather than adding zero months", () => {
    /*
     * The schema rejects this long before the service, but a quote that
     * silently added nothing would be worse than a refusal — the operator would
     * confirm a renewal that moved no date.
     */
    expect(quoteRenewal(live, preset("18_months"), at("2026-10-01"))).toBeNull();
  });

  it("always adds at least one day when it does answer", () => {
    for (const entry of RENEWAL_PRESETS) {
      const quote = quoteRenewal(live, preset(entry.id), at("2026-10-01"));
      expect(quote?.addedDays).toBeGreaterThan(0);
      expect(quote?.durationDays).toBeGreaterThan(0);
    }
  });
});
