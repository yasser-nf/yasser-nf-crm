import { describe, expect, it } from "vitest";

import {
  confirmRenewalSchema,
  renewLookupSchema,
  renewQuoteSchema,
  renewalDurationSchema,
} from "@/modules/quick-renew";
import { MAX_DURATION_DAYS, MIN_DURATION_DAYS } from "@/modules/quick-prepare";

/**
 * Quick Renew input validation. M09 §8 and §18.
 *
 * The list of rejections is taken from §8 verbatim: zero, negative, decimal,
 * non-numeric, absurdly large. The bounds themselves are NOT restated here —
 * they are imported from Quick Prepare, which is the point: a renewal that
 * could run longer than a sale would be a second answer to one question.
 */

const uuid = "aaaaaaaa-0000-4000-8000-00000000000";

describe("the shared duration bounds", () => {
  it("reuses Quick Prepare's rule rather than inventing one", () => {
    expect(MIN_DURATION_DAYS).toBe(1);
    expect(MAX_DURATION_DAYS).toBe(730);
  });
});

describe("renewal duration — presets", () => {
  it.each([["1_month"], ["2_months"], ["3_months"], ["6_months"], ["1_year"]])(
    "accepts %s",
    (preset) => {
      expect(renewalDurationSchema.safeParse({ kind: "preset", preset }).success).toBe(true);
    },
  );

  it.each([["18_months"], ["1_week"], ["forever"], [""]])("refuses %s", (preset) => {
    expect(renewalDurationSchema.safeParse({ kind: "preset", preset }).success).toBe(false);
  });

  it("refuses a preset with a day count attached", () => {
    /* A discriminated union, so a shape carrying both cannot be submitted. */
    expect(renewalDurationSchema.safeParse({ kind: "preset", days: 30 }).success).toBe(false);
  });
});

describe("renewal duration — custom days", () => {
  it.each([[1], [30], [60], [90], [180], [365], [729], [730]])("accepts %s days", (days) => {
    expect(renewalDurationSchema.safeParse({ kind: "custom", days }).success).toBe(true);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["very negative", -365],
    ["a decimal", 30.5],
    ["a tiny fraction", 0.1],
    ["beyond two years", 731],
    ["absurd", 100_000],
    ["not a number", "30"],
    ["null", null],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("refuses %s", (_label, days) => {
    expect(renewalDurationSchema.safeParse({ kind: "custom", days }).success).toBe(false);
  });

  it("explains a decimal rather than rounding it", () => {
    const parsed = renewalDurationSchema.safeParse({ kind: "custom", days: 30.5 });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("whole number");
  });

  it("refuses an unknown kind", () => {
    expect(renewalDurationSchema.safeParse({ kind: "months", months: 3 }).success).toBe(false);
  });
});

describe("the account lookup", () => {
  it("normalises the email the operator typed", () => {
    const parsed = renewLookupSchema.safeParse({ accountEmail: "  Mixed.Case@Example.Invalid " });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.accountEmail).toBe("mixed.case@example.invalid");
  });

  it.each([[""], ["   "], ["not-an-email"], ["@example.invalid"], ["a@"]])(
    "refuses %s",
    (accountEmail) => {
      expect(renewLookupSchema.safeParse({ accountEmail }).success).toBe(false);
    },
  );
});

describe("the quote request", () => {
  it("needs a profile and a duration", () => {
    expect(
      renewQuoteSchema.safeParse({
        profileId: `${uuid}1`,
        duration: { kind: "preset", preset: "3_months" },
      }).success,
    ).toBe(true);
  });

  it("refuses a profile id that is not a uuid", () => {
    expect(
      renewQuoteSchema.safeParse({
        profileId: "2",
        duration: { kind: "preset", preset: "3_months" },
      }).success,
    ).toBe(false);
  });
});

describe("the confirmation", () => {
  const valid = {
    profileId: `${uuid}1`,
    accountId: `${uuid}2`,
    customerId: `${uuid}3`,
    expectedExpirationDate: "2026-10-20",
    duration: { kind: "preset", preset: "3_months" },
    operationId: `${uuid}4`,
  };

  /** The confirmation without one field, for the "required" cases. */
  function omit(field: keyof typeof valid): Record<string, unknown> {
    const partial: Record<string, unknown> = { ...valid };
    delete partial[field];
    return partial;
  }

  it("accepts a complete confirmation", () => {
    expect(confirmRenewalSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a null expected expiry — a real state, not an omission", () => {
    expect(confirmRenewalSchema.safeParse({ ...valid, expectedExpirationDate: null }).success).toBe(
      true,
    );
  });

  it("refuses a MISSING expected expiry, which would skip the staleness check", () => {
    expect(confirmRenewalSchema.safeParse(omit("expectedExpirationDate")).success).toBe(false);
  });

  it.each([["20/10/2026"], ["2026-10-20T00:00:00Z"], ["2026-1-1"], ["yesterday"]])(
    "refuses %s as an expected expiry",
    (expectedExpirationDate) => {
      expect(confirmRenewalSchema.safeParse({ ...valid, expectedExpirationDate }).success).toBe(
        false,
      );
    },
  );

  it.each([["accountId"], ["customerId"], ["profileId"], ["duration"]] as const)(
    "refuses a confirmation without %s",
    (field) => {
      expect(confirmRenewalSchema.safeParse(omit(field)).success).toBe(false);
    },
  );

  it("caps the note, so free text cannot be used as storage", () => {
    expect(confirmRenewalSchema.safeParse({ ...valid, notes: "x".repeat(2001) }).success).toBe(
      false,
    );
  });

  it("permits an absent operation id — server callers get a fresh one", () => {
    expect(confirmRenewalSchema.safeParse(omit("operationId")).success).toBe(true);
  });
});
