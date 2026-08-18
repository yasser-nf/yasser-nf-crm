import { describe, expect, it } from "vitest";

import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";
import {
  accountRemainingDays,
  canCoverDuration,
  isAccountExpired,
  isAllocationExpired,
  isProfileFree,
  isSellableSlot,
  remainingCustomerDays,
  resolveValidity,
} from "@/modules/accounts";

/**
 * Account inventory validity.
 *
 * These are the rules M13 §1 and §11 turn on, and every one of them has a null
 * case that means "open-ended" rather than "expired". That distinction is the
 * single most dangerous thing in this milestone: every account created before
 * M13 has a null valid_until, so reading null as expired would take the entire
 * existing inventory out of circulation. It is asserted repeatedly and on
 * purpose.
 */

const TODAY = new Date("2026-08-12T09:30:00Z");

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: "stock@example.com",
    passwordEncrypted: "v1:a:b:c",
    status: "healthy",
    healthScore: 100,
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

describe("account remaining validity", () => {
  it("reports null for an open-ended account rather than zero", () => {
    /*
     * The load-bearing case. Zero would mean "cannot cover anything"; null means
     * "no boundary". Every pre-M13 account is in this state.
     */
    expect(accountRemainingDays(account(), TODAY)).toBeNull();
  });

  it("counts whole days to the boundary", () => {
    expect(accountRemainingDays(account({ validUntil: "2026-08-30" }), TODAY)).toBe(18);
  });

  it("counts zero on the last day, not negative", () => {
    expect(accountRemainingDays(account({ validUntil: "2026-08-12" }), TODAY)).toBe(0);
  });

  it("goes negative once past", () => {
    expect(accountRemainingDays(account({ validUntil: "2026-08-01" }), TODAY)).toBe(-11);
  });

  it("ignores the time of day on both sides", () => {
    /* A boundary that moves with the clock produces expiries at midnight. */
    const earlyMorning = new Date("2026-08-12T00:00:01Z");
    const lateEvening = new Date("2026-08-12T23:59:59Z");
    const validUntil = "2026-08-30";

    expect(accountRemainingDays(account({ validUntil }), earlyMorning)).toBe(
      accountRemainingDays(account({ validUntil }), lateEvening),
    );
  });
});

describe("isAccountExpired", () => {
  it("never treats an open-ended account as expired", () => {
    expect(isAccountExpired(account(), TODAY)).toBe(false);
  });

  it("is still valid on the final day", () => {
    /* An account expiring today can still serve today. */
    expect(isAccountExpired(account({ validUntil: "2026-08-12" }), TODAY)).toBe(false);
  });

  it("is expired the day after", () => {
    expect(isAccountExpired(account({ validUntil: "2026-08-11" }), TODAY)).toBe(true);
  });
});

describe("canCoverDuration — the M13 §1 rule", () => {
  it("lets an open-ended account cover any duration", () => {
    expect(canCoverDuration(account(), 730, TODAY)).toBe(true);
  });

  it("covers a duration equal to what remains", () => {
    /* 18 days left, 18 requested. The boundary is inclusive. */
    expect(canCoverDuration(account({ validUntil: "2026-08-30" }), 18, TODAY)).toBe(true);
  });

  it("refuses one day more than it has", () => {
    expect(canCoverDuration(account({ validUntil: "2026-08-30" }), 19, TODAY)).toBe(false);
  });

  it("refuses the case from the brief: 30 days of stock, 90 requested", () => {
    expect(canCoverDuration(account({ validUntil: "2026-09-11" }), 90, TODAY)).toBe(false);
  });
});

describe("isSellableSlot", () => {
  it("permits every profile when the account sells five", () => {
    for (const profileNumber of [1, 2, 3, 4, 5]) {
      expect(isSellableSlot(profile({ profileNumber }), account({ profileSlots: 5 }))).toBe(true);
    }
  });

  it("stops at the slot count", () => {
    const threeSlots = account({ profileSlots: 3 });

    expect(isSellableSlot(profile({ profileNumber: 3 }), threeSlots)).toBe(true);
    expect(isSellableSlot(profile({ profileNumber: 4 }), threeSlots)).toBe(false);
    expect(isSellableSlot(profile({ profileNumber: 5 }), threeSlots)).toBe(false);
  });

  it("reads the slot count, not the stored status", () => {
    /*
     * Deliberate: this must stay correct for a row whose status was never
     * rewritten — after a manual SQL edit, or mid-transaction.
     */
    const stale = profile({ profileNumber: 4, status: "available" });
    expect(isSellableSlot(stale, account({ profileSlots: 2 }))).toBe(false);
  });
});

describe("isAllocationExpired and isProfileFree", () => {
  it("treats an available profile as free", () => {
    expect(isProfileFree(profile(), TODAY)).toBe(true);
  });

  it("treats a live sold profile as taken", () => {
    const sold = profile({ status: "sold", expirationDate: "2026-09-30" });

    expect(isAllocationExpired(sold, TODAY)).toBe(false);
    expect(isProfileFree(sold, TODAY)).toBe(false);
  });

  it("frees a sold profile whose customer has expired", () => {
    /*
     * 03_DATABASE.md: "Expired Profile → Automatically Available if account is
     * Healthy." Nothing ever wrote the `expired` status, so before M13 this
     * profile stayed sold forever and could never be resold.
     */
    const lapsed = profile({ status: "sold", expirationDate: "2026-08-01" });

    expect(isAllocationExpired(lapsed, TODAY)).toBe(true);
    expect(isProfileFree(lapsed, TODAY)).toBe(true);
  });

  it("does not free a profile on its final day", () => {
    const lastDay = profile({ status: "sold", expirationDate: "2026-08-12" });
    expect(isProfileFree(lastDay, TODAY)).toBe(false);
  });

  it("says nothing about sellable slots — that is a separate question", () => {
    /*
     * A slot above profile_slots is still `available` at the column level, so
     * isProfileFree correctly calls it free. Sellability is isSellableSlot's
     * job, and evaluateAllocation applies both. Keeping the two orthogonal is
     * what lets the blocked reason name the right one.
     */
    const parked = profile({ profileNumber: 5, status: "available" });

    expect(isProfileFree(parked, TODAY)).toBe(true);
    expect(isSellableSlot(parked, { ...account(), profileSlots: 2 })).toBe(false);
  });

  it("treats an open-ended sold profile as taken, not free", () => {
    /* No expiration recorded means it never lapses on its own. */
    expect(isProfileFree(profile({ status: "sold", expirationDate: null }), TODAY)).toBe(false);
  });
});

describe("remainingCustomerDays — what Quick Replace must preserve", () => {
  it("carries over the remainder, not the original duration", () => {
    /*
     * The example from M13 §9, exactly: 90 days bought, 40 consumed, 50 left.
     * A replacement must receive 50, never a fresh 90.
     */
    const sold = profile({
      status: "sold",
      durationDays: 90,
      saleDate: "2026-07-03",
      expirationDate: "2026-10-01",
    });

    expect(remainingCustomerDays(sold, TODAY)).toBe(50);
  });

  it("never returns a negative number for a lapsed allocation", () => {
    /* Negative days would be trivially coverable by an expired account. */
    const lapsed = profile({ status: "sold", durationDays: 30, expirationDate: "2026-07-01" });
    expect(remainingCustomerDays(lapsed, TODAY)).toBe(0);
  });

  it("falls back to the sold duration when no expiry was recorded", () => {
    const openEnded = profile({ status: "sold", durationDays: 60, expirationDate: null });
    expect(remainingCustomerDays(openEnded, TODAY)).toBe(60);
  });
});

describe("resolveValidity", () => {
  it("keeps an account open-ended when nothing is supplied", () => {
    expect(resolveValidity({}, TODAY)).toEqual({ validFrom: null, validUntil: null });
  });

  it("turns a duration into a boundary counted from today", () => {
    expect(resolveValidity({ durationDays: 90 }, TODAY)).toEqual({
      validFrom: null,
      validUntil: "2026-11-10",
    });
  });

  it("counts a duration from valid_from when one is given", () => {
    /* An account bought to start next month expires a duration after it starts. */
    expect(resolveValidity({ validFrom: "2026-09-01", durationDays: 30 }, TODAY)).toEqual({
      validFrom: "2026-09-01",
      validUntil: "2026-10-01",
    });
  });

  it("lets an explicit boundary win over a duration", () => {
    expect(resolveValidity({ validUntil: "2026-12-25", durationDays: 5 }, TODAY).validUntil).toBe(
      "2026-12-25",
    );
  });
});
