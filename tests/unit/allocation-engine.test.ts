import { describe, expect, it } from "vitest";

import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";
/*
 * Imported from the engine directly rather than through the module barrel.
 * The barrel also re-exports the service, which imports `server-only` and
 * throws outside a Server Component. This is a unit test of a pure unit, so
 * reaching the unit directly is the honest import.
 */
import {
  buildAllocationPlan,
  computeExpirationDate,
  todayAsDate,
} from "@/modules/quick-prepare/services/allocation-engine";
import type { AllocationCandidate } from "@/modules/quick-prepare/repositories/allocation.repository";

/**
 * Allocation engine tests.
 *
 * The engine is pure by design — no database, no clock, no randomness — which is
 * exactly what makes the heart of the CRM testable. ADR-007 Decision 1 defines
 * the strategy these tests enforce: concentrate, never fragment.
 */

function account(id: string): AccountRow {
  return {
    id,
    email: `${id}@example.com`,
    passwordEncrypted: "v1:a:b:c",
    status: "healthy",
    /* M13 defaults: sells all five, open-ended coverage. */
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
}

function profile(id: string, accountId: string, profileNumber: number): ProfileRow {
  return {
    id,
    accountId,
    profileNumber,
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
  };
}

function candidate(
  id: string,
  free: number,
  soldCount = 0,
  /* Null is open-ended coverage — the pre-M13 behaviour every old test assumes. */
  remainingValidityDays: number | null = null,
): AllocationCandidate {
  return {
    account: account(id),
    availableProfiles: Array.from({ length: free }, (_, i) =>
      profile(`${id}-p${i + 1}`, id, i + 1),
    ),
    soldCount,
    remainingValidityDays,
  };
}

describe("buildAllocationPlan — concentration (ADR-007 D1)", () => {
  it("uses one account when one account can cover the request", () => {
    const plan = buildAllocationPlan([candidate("a", 1, 4), candidate("b", 3)], 3);
    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0]?.account.id).toBe("b");
  });

  it("never fragments a request that fits in a single account", () => {
    const plan = buildAllocationPlan(
      [candidate("a", 1), candidate("b", 1), candidate("c", 1), candidate("d", 5)],
      3,
    );
    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0]?.account.id).toBe("d");
  });

  it("prefers a partially sold account when both can serve", () => {
    const plan = buildAllocationPlan([candidate("fresh", 5, 0), candidate("used", 5, 3)], 2);
    expect(plan.slices[0]?.account.id).toBe("used");
  });

  it("spans accounts only when no single account suffices", () => {
    const plan = buildAllocationPlan([candidate("a", 3), candidate("b", 3)], 5);
    expect(plan.slices).toHaveLength(2);
    expect(plan.allocated).toBe(5);
  });

  it("prefers the tighter fit to keep large blocks intact", () => {
    const plan = buildAllocationPlan([candidate("big", 5), candidate("exact", 2)], 2);
    expect(plan.slices[0]?.account.id).toBe("exact");
  });

  it("ranks covering the request above being partially sold", () => {
    const plan = buildAllocationPlan([candidate("partial", 1, 4), candidate("covers", 4, 0)], 4);
    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0]?.account.id).toBe("covers");
  });

  it("prefers an account already partially sold, to concentrate the sale", () => {
    /*
     * Was "ranks partially sold above raw health score". The health term is
     * gone from the ranking — it was the same constant for every candidate —
     * but the preference it outranked is unchanged and still worth pinning.
     */
    const plan = buildAllocationPlan([candidate("healthy", 1, 0), candidate("used", 1, 2)], 2);
    expect(plan.slices[0]?.account.id).toBe("used");
  });
});

describe("buildAllocationPlan — all or nothing", () => {
  it("allocates nothing when stock is short", () => {
    const plan = buildAllocationPlan([candidate("a", 2)], 5);
    expect(plan.isShort).toBe(true);
    expect(plan.allocated).toBe(0);
    expect(plan.slices).toHaveLength(0);
  });

  it("reports the true availability so the UI can explain", () => {
    const plan = buildAllocationPlan([candidate("a", 2), candidate("b", 1)], 10);
    expect(plan.availableTotal).toBe(3);
  });

  it("is short when there are no candidates at all", () => {
    const plan = buildAllocationPlan([], 1);
    expect(plan.isShort).toBe(true);
    expect(plan.availableTotal).toBe(0);
  });

  it("treats a zero request as short rather than succeeding vacuously", () => {
    expect(buildAllocationPlan([candidate("a", 5)], 0).isShort).toBe(true);
  });

  it("treats a negative request as short", () => {
    expect(buildAllocationPlan([candidate("a", 5)], -3).isShort).toBe(true);
  });

  it("allocates exactly when supply equals demand", () => {
    const plan = buildAllocationPlan([candidate("a", 2), candidate("b", 3)], 5);
    expect(plan.isShort).toBe(false);
    expect(plan.allocated).toBe(5);
  });
});

describe("buildAllocationPlan — output shape", () => {
  it("never allocates more than requested", () => {
    const plan = buildAllocationPlan([candidate("a", 5)], 2);
    expect(plan.allocated).toBe(2);
    expect(plan.slices[0]?.profiles).toHaveLength(2);
  });

  it("takes the lowest profile numbers first", () => {
    const plan = buildAllocationPlan([candidate("a", 5)], 3);
    expect(plan.slices[0]?.profiles.map((p) => p.profileNumber)).toEqual([1, 2, 3]);
  });

  it("never repeats a profile across slices", () => {
    const plan = buildAllocationPlan([candidate("a", 3), candidate("b", 3)], 6);
    const ids = plan.slices.flatMap((s) => s.profiles.map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never reuses an account across slices", () => {
    const plan = buildAllocationPlan([candidate("a", 3), candidate("b", 3)], 6);
    const accountIds = plan.slices.map((s) => s.account.id);
    expect(new Set(accountIds).size).toBe(accountIds.length);
  });

  it("echoes the requested count", () => {
    expect(buildAllocationPlan([candidate("a", 5)], 4).requested).toBe(4);
  });
});

describe("buildAllocationPlan — determinism", () => {
  it("produces an identical plan on repeated runs", () => {
    const pool = [candidate("a", 2, 1), candidate("b", 3, 0), candidate("c", 1, 5)];
    const first = buildAllocationPlan(pool, 4);
    const second = buildAllocationPlan(pool, 4);
    expect(first.slices.map((s) => s.account.id)).toEqual(second.slices.map((s) => s.account.id));
  });

  it("does not mutate the candidate array", () => {
    const pool = [candidate("a", 3), candidate("b", 3)];
    const before = pool.length;
    buildAllocationPlan(pool, 5);
    expect(pool).toHaveLength(before);
  });

  it("does not mutate a candidate's profile list", () => {
    const pool = [candidate("a", 5)];
    buildAllocationPlan(pool, 2);
    expect(pool[0]?.availableProfiles).toHaveLength(5);
  });
});

describe("buildAllocationPlan — account validity (M13)", () => {
  it("behaves exactly as before when no duration is supplied", () => {
    /* The preview count path. Nothing about M13 changes it. */
    const plan = buildAllocationPlan([candidate("short", 5, 0, 3)], 2);

    expect(plan.isShort).toBe(false);
    expect(plan.excludedForValidity).toBe(0);
    expect(plan.rejected).toEqual([]);
  });

  it("excludes an account that cannot cover the requested duration", () => {
    const plan = buildAllocationPlan([candidate("short", 5, 0, 30)], 2, {
      requestedDurationDays: 90,
    });

    expect(plan.isShort).toBe(true);
    expect(plan.availableTotal).toBe(0);
    expect(plan.excludedForValidity).toBe(5);
  });

  it("keeps an account whose validity exactly matches the request", () => {
    /* The boundary is inclusive: 90 days left covers a 90-day sale. */
    const plan = buildAllocationPlan([candidate("exact", 5, 0, 90)], 2, {
      requestedDurationDays: 90,
    });

    expect(plan.isShort).toBe(false);
    expect(plan.slices[0]?.account.id).toBe("exact");
  });

  it("treats open-ended validity as covering anything", () => {
    const plan = buildAllocationPlan([candidate("open", 5, 0, null)], 2, {
      requestedDurationDays: 730,
    });

    expect(plan.isShort).toBe(false);
  });

  it("reports the numbers behind a rejection", () => {
    /* So the service can say "Only 18 days remaining, 90 requested". */
    const plan = buildAllocationPlan([candidate("short", 3, 0, 18)], 2, {
      requestedDurationDays: 90,
    });

    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]).toMatchObject({
      accountId: "short",
      freeProfiles: 3,
      remainingDays: 18,
      requestedDays: 90,
    });
  });

  it("distinguishes no stock from short-dated stock", () => {
    /*
     * Two problems with opposite answers: buy more accounts, versus sell this
     * customer a shorter subscription. Reporting both as "not enough profiles"
     * hides the second one.
     */
    const noStock = buildAllocationPlan([], 2, { requestedDurationDays: 90 });
    const shortDated = buildAllocationPlan([candidate("s", 5, 0, 10)], 2, {
      requestedDurationDays: 90,
    });

    expect(noStock.excludedForValidity).toBe(0);
    expect(shortDated.excludedForValidity).toBe(5);
    expect(noStock.isShort && shortDated.isShort).toBe(true);
  });

  it("counts only usable stock in availableTotal", () => {
    /*
     * Telling a worker "8 available" when none of it can be sold for this
     * duration is worse than telling them nothing.
     */
    const plan = buildAllocationPlan(
      [candidate("good", 3, 0, 365), candidate("short", 5, 0, 5)],
      10,
      { requestedDurationDays: 90 },
    );

    expect(plan.availableTotal).toBe(3);
    expect(plan.excludedForValidity).toBe(5);
  });
});

describe("buildAllocationPlan — near-expiry penalty (M13)", () => {
  it("prefers a long-dated account over a short-dated one", () => {
    const plan = buildAllocationPlan(
      [candidate("expiring", 5, 0, 10), candidate("fresh", 5, 0, 365)],
      2,
      { requestedDurationDays: 5 },
    );

    expect(plan.slices[0]?.account.id).toBe("fresh");
  });

  it("still uses a short-dated account when it is the only one that fits", () => {
    /*
     * The approval is explicit: "Accounts nearing expiration should not
     * immediately disappear... Only reject when remaining validity is
     * insufficient." A penalty reorders; it never excludes.
     */
    const plan = buildAllocationPlan([candidate("expiring", 5, 0, 10)], 2, {
      requestedDurationDays: 5,
    });

    expect(plan.isShort).toBe(false);
    expect(plan.slices[0]?.account.id).toBe("expiring");
  });

  it("outranks partial-sale concentration", () => {
    /*
     * The penalty must be big enough that a perfect-health, partly-sold,
     * nearly-expired account still loses to a plain healthy one.
     */
    const plan = buildAllocationPlan(
      [candidate("expiring", 5, 3, 2), candidate("fresh", 5, 0, 365)],
      2,
      { requestedDurationDays: 1 },
    );

    expect(plan.slices[0]?.account.id).toBe("fresh");
  });

  it("does not penalise an open-ended account", () => {
    const plan = buildAllocationPlan(
      [candidate("open", 5, 0, null), candidate("expiring", 5, 0, 3)],
      2,
      { requestedDurationDays: 1 },
    );

    expect(plan.slices[0]?.account.id).toBe("open");
  });

  it("does not stop a short-dated account from covering the whole order alone", () => {
    /*
     * Splitting a customer across two accounts to save a few days of shelf life
     * is a worse outcome for that customer, so coversRequest outranks the
     * penalty deliberately.
     */
    const plan = buildAllocationPlan(
      [candidate("expiring", 4, 0, 5), candidate("fresh", 2, 0, 365)],
      4,
      { requestedDurationDays: 3 },
    );

    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0]?.account.id).toBe("expiring");
  });
});

describe("computeExpirationDate", () => {
  const cases: [string, number, string][] = [
    ["2026-08-08T00:00:00Z", 30, "2026-09-07"],
    ["2026-08-08T22:00:00Z", 30, "2026-09-07"],
    ["2026-12-31T00:00:00Z", 1, "2027-01-01"],
    ["2026-01-01T00:00:00Z", 365, "2027-01-01"],
    ["2028-02-28T00:00:00Z", 1, "2028-02-29"],
    ["2026-02-28T00:00:00Z", 1, "2026-03-01"],
    ["2026-01-31T00:00:00Z", 1, "2026-02-01"],
    ["2026-06-15T00:00:00Z", 90, "2026-09-13"],
    ["2026-06-15T00:00:00Z", 7, "2026-06-22"],
  ];

  for (const [from, days, expected] of cases) {
    it(`${days} days from ${from.slice(0, 10)} is ${expected}`, () => {
      expect(computeExpirationDate(new Date(from), days)).toBe(expected);
    });
  }

  it("is unaffected by the time of day", () => {
    const morning = computeExpirationDate(new Date("2026-08-08T01:00:00Z"), 30);
    const night = computeExpirationDate(new Date("2026-08-08T23:59:00Z"), 30);
    expect(morning).toBe(night);
  });

  it("returns a bare date with no time component", () => {
    expect(computeExpirationDate(new Date("2026-08-08T12:00:00Z"), 30)).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});

describe("todayAsDate", () => {
  it("returns a bare date", () => {
    expect(todayAsDate(new Date("2026-08-08T15:30:00Z"))).toBe("2026-08-08");
  });

  it("uses the same UTC frame as expiry, so the two never disagree", () => {
    const now = new Date("2026-08-08T23:59:59Z");
    expect(computeExpirationDate(now, 0)).toBe(todayAsDate(now));
  });
});
