import { describe, expect, it } from "vitest";

import { EXPIRING_SOON_DAYS, isExpiringSoon } from "@/lib/dates";
import { expiryUrgency } from "@/modules/customers";
import { PROFILE_STATE_LABELS, PROFILE_STATE_STYLES } from "@/shared/ui/profile-state";

/**
 * The expiring-soon window, and the colour it paints.
 *
 * One threshold, `EXPIRING_SOON_DAYS`, shared by the profile badges and the
 * customer expiry badges. It was already three days — the highlight M05
 * specifies, which `expiryUrgency` has always applied — and this feature reuses
 * it rather than introducing a second definition of "soon".
 *
 * The badge is computed from expiration_date at read time, so a slot turns
 * yellow on its own as the date approaches. Nothing writes the `expiring_soon`
 * status column and nothing here reads it.
 */

const TODAY = new Date("2026-09-02T09:30:00Z");

describe("the shared threshold", () => {
  it("is three days", () => {
    expect(EXPIRING_SOON_DAYS).toBe(3);
  });

  it("is the same window the customer screens highlight", () => {
    /*
     * The guard against a second definition of soon. If either side changed its
     * own number, these would disagree.
     */
    expect(expiryUrgency("2026-09-05", TODAY)).toBe("soon");
    expect(isExpiringSoon("2026-09-05", TODAY)).toBe(true);

    expect(expiryUrgency("2026-09-06", TODAY)).toBe("later");
    expect(isExpiringSoon("2026-09-06", TODAY)).toBe(false);
  });
});

describe("what counts as expiring soon", () => {
  it.each([
    ["2026-09-02", true, "expires today"],
    ["2026-09-03", true, "expires tomorrow"],
    ["2026-09-04", true, "two days out"],
    ["2026-09-05", true, "exactly on the threshold"],
    ["2026-09-06", false, "one day past the threshold"],
    ["2026-12-01", false, "months away"],
  ])("%s -> %s (%s)", (date, expected) => {
    expect(isExpiringSoon(date, TODAY)).toBe(expected);
  });

  it("is false once the date has passed", () => {
    /*
     * Expired is a different state with a different colour. Answering true for
     * both would make every caller re-check what it just asked.
     */
    expect(isExpiringSoon("2026-09-01", TODAY)).toBe(false);
    expect(isExpiringSoon("2020-01-01", TODAY)).toBe(false);
  });

  it("treats an absent boundary as open-ended, never soon", () => {
    expect(isExpiringSoon(null, TODAY)).toBe(false);
  });

  it("moves with the clock, without anything being edited", () => {
    /*
     * Requirement: the yellow appears on its own as time passes. Same profile,
     * same stored date, two different days.
     */
    const expiration = "2026-09-05";

    expect(isExpiringSoon(expiration, new Date("2026-09-01T00:00:00Z"))).toBe(false);
    expect(isExpiringSoon(expiration, new Date("2026-09-02T00:00:00Z"))).toBe(true);
  });
});

describe("the colour it paints", () => {
  it("is yellow, and not the orange used by blocked", () => {
    /*
     * The two appear on the same row. One hue apart would not be a distinction
     * anybody could act on, which is why this state got its own token rather
     * than reusing --color-warning.
     */
    expect(PROFILE_STATE_STYLES.expiring_soon).toContain("caution");
    expect(PROFILE_STATE_STYLES.expiring_soon).not.toContain("warning");
    expect(PROFILE_STATE_STYLES.blocked).toContain("warning");
    expect(PROFILE_STATE_STYLES.expiring_soon).not.toBe(PROFILE_STATE_STYLES.blocked);
  });

  it("is distinct from every other state", () => {
    const styles = Object.values(PROFILE_STATE_STYLES);

    expect(new Set(styles).size).toBe(styles.length);
  });

  it("keeps the established colours where they were", () => {
    expect(PROFILE_STATE_STYLES.sold).toContain("success");
    expect(PROFILE_STATE_STYLES.expired).toContain("danger");
    expect(PROFILE_STATE_STYLES.blocked).toContain("warning");
    expect(PROFILE_STATE_STYLES.available).toContain("surface-raised");
    expect(PROFILE_STATE_STYLES.not_for_sale).toContain("dashed");
  });

  it("reads as a phase of sold, not a fault", () => {
    expect(PROFILE_STATE_LABELS.expiring_soon).toBe("expiring soon");
    expect(PROFILE_STATE_LABELS.sold).toBe("sold, active");
  });
});
