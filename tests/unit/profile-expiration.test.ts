import { describe, expect, it } from "vitest";

import { addDaysToDateString, parseDateString } from "@/lib/dates";
import {
  deriveExpirationDate,
  deriveExpirationForInput,
  resolveExpirationDate,
} from "@/modules/accounts/services/profile-dates";

/**
 * Profile expiration is derived, never entered.
 *
 * The bug these cover: sale date, duration and expiration were three
 * independent fields, so changing the duration left the old expiration in place
 * and the row disagreed with itself. Expiration is now computed from the other
 * two everywhere it is shown or stored, which makes "do they agree" a question
 * with only one possible answer.
 *
 * Dates are the classic place for an off-by-one nobody sees for months, so the
 * boundaries are pinned explicitly rather than trusted.
 */

describe("the examples from the bug report", () => {
  it("01/09/2026 + 90 days is 30/11/2026", () => {
    expect(deriveExpirationDate("2026-09-01", 90)).toBe("2026-11-30");
  });

  it("changing the duration from 90 to 30 moves expiration to 01/10/2026", () => {
    /* The exact failure: this used to keep showing 30/11/2026. */
    expect(deriveExpirationDate("2026-09-01", 90)).toBe("2026-11-30");
    expect(deriveExpirationDate("2026-09-01", 30)).toBe("2026-10-01");
  });

  it("moving the sale date to 10/09/2026 keeps the duration and gives 09/12/2026", () => {
    expect(deriveExpirationDate("2026-09-10", 90)).toBe("2026-12-09");
  });
});

describe("changing one input at a time", () => {
  it("recalculates when only the duration changes", () => {
    const saleDate = "2026-09-01";

    expect(deriveExpirationDate(saleDate, 30)).toBe("2026-10-01");
    expect(deriveExpirationDate(saleDate, 60)).toBe("2026-10-31");
    expect(deriveExpirationDate(saleDate, 90)).toBe("2026-11-30");
  });

  it("recalculates when only the sale date changes", () => {
    const duration = 90;

    expect(deriveExpirationDate("2026-09-01", duration)).toBe("2026-11-30");
    expect(deriveExpirationDate("2026-09-10", duration)).toBe("2026-12-09");
    expect(deriveExpirationDate("2026-10-01", duration)).toBe("2026-12-30");
  });

  it("recalculates when both change together", () => {
    expect(deriveExpirationDate("2026-09-01", 90)).toBe("2026-11-30");
    expect(deriveExpirationDate("2026-03-15", 30)).toBe("2026-04-14");
  });
});

describe("the durations this CRM actually sells", () => {
  const saleDate = "2026-01-15";

  it.each([
    [30, "2026-02-14"],
    [60, "2026-03-16"],
    [90, "2026-04-15"],
    [180, "2026-07-14"],
    [365, "2027-01-15"],
  ])("%i days from 2026-01-15 is %s", (days, expected) => {
    expect(deriveExpirationDate(saleDate, days)).toBe(expected);
  });

  it("365 days from a date inside a leap year lands a day earlier", () => {
    /*
     * 2028 is a leap year, so a year of 365 days ends on the 14th rather than
     * the 15th. Worth pinning: it looks like an off-by-one and is not one.
     */
    expect(deriveExpirationDate("2028-01-15", 365)).toBe("2029-01-14");
  });
});

describe("month and year boundaries", () => {
  it("crosses into the next month", () => {
    expect(deriveExpirationDate("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("crosses into the next year", () => {
    expect(deriveExpirationDate("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("crosses a whole year end from mid-December", () => {
    expect(deriveExpirationDate("2026-12-15", 30)).toBe("2027-01-14");
  });

  it("handles a 31-day month followed by a 30-day one", () => {
    expect(deriveExpirationDate("2026-07-31", 31)).toBe("2026-08-31");
    expect(deriveExpirationDate("2026-08-31", 31)).toBe("2026-10-01");
  });
});

describe("leap years", () => {
  it("counts 29 February in a leap year", () => {
    expect(deriveExpirationDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(deriveExpirationDate("2028-02-28", 2)).toBe("2028-03-01");
  });

  it("skips it in an ordinary year", () => {
    expect(deriveExpirationDate("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("spans the leap day", () => {
    expect(deriveExpirationDate("2028-01-31", 30)).toBe("2028-03-01");
    /* The same span in a non-leap year lands a day later in March. */
    expect(deriveExpirationDate("2026-01-31", 30)).toBe("2026-03-02");
  });

  it("respects the century rule", () => {
    /* 2100 is divisible by 100 but not 400, so it is not a leap year. */
    expect(deriveExpirationDate("2100-02-28", 1)).toBe("2100-03-01");
    /* 2000 is divisible by 400, so it was. */
    expect(deriveExpirationDate("2000-02-28", 1)).toBe("2000-02-29");
  });
});

describe("timezones cannot shift the day", () => {
  it("parses a calendar date as UTC midnight, whatever the machine is set to", () => {
    /*
     * The off-by-one this prevents: `new Date("2026-09-01T00:00:00")` is parsed
     * as local time, so west of Greenwich it is 31 August in UTC. Appending Z
     * is what keeps a date column a calendar date.
     */
    expect(parseDateString("2026-09-01")?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("returns the sale date itself for a zero-day shift", () => {
    expect(addDaysToDateString("2026-09-01", 0)).toBe("2026-09-01");
  });

  it("never drifts across a long run of single days", () => {
    /* A drift of one hour per step would show up as a wrong date within weeks. */
    let cursor = "2026-01-01";

    for (let i = 0; i < 400; i += 1) {
      cursor = addDaysToDateString(cursor, 1) ?? "";
    }

    /* 2026 is not a leap year: 365 days to 2027-01-01, then 35 more. */
    expect(cursor).toBe("2027-02-05");
  });
});

describe("what cannot be derived", () => {
  it("returns null without a sale date", () => {
    expect(deriveExpirationDate(null, 90)).toBeNull();
    expect(deriveExpirationDate("", 90)).toBeNull();
  });

  it("returns null without a duration", () => {
    expect(deriveExpirationDate("2026-09-01", null)).toBeNull();
  });

  it("refuses a duration that is not a whole positive number of days", () => {
    expect(deriveExpirationDate("2026-09-01", 0)).toBeNull();
    expect(deriveExpirationDate("2026-09-01", -30)).toBeNull();
    expect(deriveExpirationDate("2026-09-01", 1.5)).toBeNull();
  });

  it("returns null for a date it cannot parse", () => {
    expect(deriveExpirationDate("not-a-date", 30)).toBeNull();
  });
});

describe("the form-shaped helper", () => {
  it("derives from the strings an HTML form produces", () => {
    expect(deriveExpirationForInput("2026-09-01", "90")).toBe("2026-11-30");
  });

  it("returns an empty string rather than null, so the input stays controlled", () => {
    /* Switching between a value and null would flip React to uncontrolled. */
    expect(deriveExpirationForInput("", "90")).toBe("");
    expect(deriveExpirationForInput("2026-09-01", "")).toBe("");
    expect(deriveExpirationForInput(undefined, undefined)).toBe("");
  });

  it("ignores a duration that is not a number", () => {
    expect(deriveExpirationForInput("2026-09-01", "abc")).toBe("");
  });

  it("agrees exactly with the strict form", () => {
    /* One rule, two shapes. If these ever disagree, the screen lies. */
    expect(deriveExpirationForInput("2026-09-01", "90")).toBe(
      deriveExpirationDate("2026-09-01", 90),
    );
  });
});

describe("loading an existing profile", () => {
  it("shows the calculated expiration, not the stored one", () => {
    /*
     * A row saved before expiration became derived can carry a value that
     * disagrees with its own sale date and duration. The modal recomputes so it
     * presents what the record means rather than the disagreement.
     */
    const stored = {
      saleDate: "2026-09-01",
      durationDays: 30,
      expirationDate: "2026-11-30", // stale: left over from a 90-day duration
    };

    const shown = deriveExpirationForInput(stored.saleDate, String(stored.durationDays));

    expect(shown).toBe("2026-10-01");
    expect(shown).not.toBe(stored.expirationDate);
  });

  it("agrees with a row that was already consistent", () => {
    const stored = { saleDate: "2026-09-01", durationDays: 90, expirationDate: "2026-11-30" };

    expect(deriveExpirationForInput(stored.saleDate, String(stored.durationDays))).toBe(
      stored.expirationDate,
    );
  });
});

describe("save then reload stays consistent", () => {
  it("writes a value that recomputes to itself", () => {
    /*
     * What the service persists and what the modal shows on the next open are
     * the same function of the same two fields, so a round trip cannot drift.
     */
    const saleDate = "2026-09-01";
    const durationDays = 90;

    const saved = deriveExpirationDate(saleDate, durationDays);
    const reloaded = deriveExpirationForInput(saleDate, String(durationDays));

    expect(saved).toBe("2026-11-30");
    expect(reloaded).toBe(saved);
  });

  it("stays stable over repeated saves", () => {
    const saleDate = "2026-02-27";

    let value = deriveExpirationDate(saleDate, 365);

    for (let i = 0; i < 5; i += 1) {
      expect(deriveExpirationDate(saleDate, 365)).toBe(value);
      value = deriveExpirationDate(saleDate, 365);
    }

    expect(value).toBe("2027-02-27");
  });

  it("keeps all three fields agreeing after an edit", () => {
    /* The invariant, stated directly: expiration is sale date plus duration. */
    const edited = { saleDate: "2026-09-10", durationDays: 180 };
    const expiration = deriveExpirationDate(edited.saleDate, edited.durationDays);

    expect(expiration).toBe("2027-03-09");
    expect(deriveExpirationForInput(edited.saleDate, String(edited.durationDays))).toBe(expiration);
  });
});

describe("what the service writes", () => {
  it("overrides a stale stored expiration with the derived one", () => {
    /*
     * The bug, at the layer that persists it. Changing the duration alone used
     * to leave the old expiration in the column, so the row disagreed with
     * itself until somebody noticed.
     */
    expect(resolveExpirationDate("2026-09-01", 30, "2026-11-30")).toBe("2026-10-01");
  });

  it("ignores whatever a client submitted for expiration", () => {
    /* A client is not the authority on a derived field. */
    expect(resolveExpirationDate("2026-09-01", 90, "1999-01-01")).toBe("2026-11-30");
  });

  it("keeps the stored value when there is no duration to derive from", () => {
    /*
     * Not the same as expiring never. Blanking this would destroy a date the
     * operator never touched, on a profile whose duration was never recorded.
     */
    expect(resolveExpirationDate("2026-09-01", null, "2026-12-25")).toBe("2026-12-25");
  });

  it("keeps the stored value when there is no sale date", () => {
    expect(resolveExpirationDate(null, 90, "2026-12-25")).toBe("2026-12-25");
  });

  it("leaves a genuinely empty allocation empty", () => {
    expect(resolveExpirationDate(null, null, null)).toBeNull();
  });

  it("writes what the modal will show on the next open", () => {
    /* Save then reload: one rule, so the round trip cannot drift. */
    const saleDate = "2026-09-10";
    const durationDays = 90;
    const written = resolveExpirationDate(saleDate, durationDays, "whatever-was-there");

    expect(written).toBe("2026-12-09");
    expect(deriveExpirationForInput(saleDate, String(durationDays))).toBe(written);
  });
});
