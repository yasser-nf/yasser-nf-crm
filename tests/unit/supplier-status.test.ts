import { describe, expect, it } from "vitest";

import {
  acceptsNewAccounts,
  deriveSupplierStatus,
  SUPPLIER_STATUS_LABELS,
} from "@/modules/suppliers";

/**
 * Supplier status, derived from `deactivated_at`. M10 §4 and §23.
 *
 * The property that matters is that there is nothing else to be wrong: the
 * status is a function of one timestamp, so it cannot disagree with a stored
 * enum that was written separately.
 */

describe("deriving the status", () => {
  it("is active while deactivated_at is null", () => {
    expect(deriveSupplierStatus({ deactivatedAt: null })).toBe("active");
  });

  it("is inactive once deactivated_at is set", () => {
    expect(deriveSupplierStatus({ deactivatedAt: new Date("2026-05-01") })).toBe("inactive");
  });

  it("does not depend on when it was deactivated", () => {
    /* Not a function of the clock, unlike expiry — a date in the future is still inactive. */
    expect(deriveSupplierStatus({ deactivatedAt: new Date("2099-01-01") })).toBe("inactive");
  });

  it("names both states for the UI", () => {
    expect(SUPPLIER_STATUS_LABELS).toEqual({ active: "Active", inactive: "Inactive" });
  });
});

describe("whether a supplier may receive a new account — M10 §23", () => {
  it("accepts while active", () => {
    expect(acceptsNewAccounts({ deactivatedAt: null })).toBe(true);
  });

  it("refuses once inactive", () => {
    expect(acceptsNewAccounts({ deactivatedAt: new Date("2026-05-01") })).toBe(false);
  });

  it("agrees with the derived status, so one rule decides both", () => {
    for (const deactivatedAt of [null, new Date("2026-05-01")]) {
      expect(acceptsNewAccounts({ deactivatedAt })).toBe(
        deriveSupplierStatus({ deactivatedAt }) === "active",
      );
    }
  });
});
