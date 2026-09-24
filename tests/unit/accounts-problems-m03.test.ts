import { describe, expect, it } from "vitest";

import { accountBadgeStyle } from "@/modules/accounts/components/status-badge";
import { accountEffectiveStatus } from "@/modules/accounts/services/account-validity";
import type { AccountRow } from "@/lib/drizzle/schema";
import { buildProfileEditPayload } from "@/modules/accounts/services/profile-edit-payload";
import {
  previewExpirationDate,
  resolveExpirationDate,
} from "@/modules/accounts/services/profile-dates";
import { createProblemSchema } from "@/modules/problems/validation/problem.schema";

/**
 * The badge the application would show: `accountEffectiveStatus` (the one
 * derivation, M03) rendered by `accountBadgeStyle`. An open account with no
 * validity boundary, so only status and problems are in play.
 */
function badgeOf(
  status: AccountRow["status"],
  hasActiveProblem: boolean,
  activeProblemTypes: readonly string[] = [],
) {
  const types = hasActiveProblem
    ? activeProblemTypes.length > 0
      ? activeProblemTypes
      : ["other"]
    : [];

  return accountBadgeStyle(
    accountEffectiveStatus(
      { status, validUntil: null, deletedAt: null },
      types,
      new Date("2026-09-24T12:00:00Z"),
    ),
  );
}

/**
 * M03 — the pure rules behind the Accounts + Problems changes.
 *
 * The integration suite (tests/integration/accounts-problems-m03.test.ts)
 * proves the screens agree over a real database; these pin the individual
 * decisions so a regression names the rule that moved.
 */

describe("the account badge names a single kind of blocking problem", () => {
  it("says Payment Problem for a healthy-stored account with an open payment problem", () => {
    expect(badgeOf("healthy", true, ["payment_problem"]).label).toBe("Payment Problem");
  });

  it("names each fault type the same way the stored status would", () => {
    expect(badgeOf("healthy", true, ["incorrect_password"]).label).toBe("Incorrect Password");
    expect(badgeOf("healthy", true, ["invalid_email"]).label).toBe("Invalid Email");
    expect(badgeOf("healthy", true, ["something_went_wrong"]).label).toBe("Something Went Wrong");
  });

  it("says Problem for several kinds, for `other`, and when types are not given", () => {
    expect(badgeOf("healthy", true, ["payment_problem", "invalid_email"]).label).toBe("Problem");
    expect(badgeOf("healthy", true, ["other"]).label).toBe("Problem");
    expect(badgeOf("healthy", true).label).toBe("Problem");
  });

  it("repeats of one type are still one type", () => {
    expect(badgeOf("healthy", true, ["payment_problem", "payment_problem"]).label).toBe(
      "Payment Problem",
    );
  });

  it("never says Healthy while a problem blocks, and a stored fault still wins", () => {
    expect(badgeOf("healthy", true, ["payment_problem"]).label).not.toBe("Healthy");
    expect(badgeOf("invalid_email", true, ["payment_problem"]).label).toBe("Invalid Email");
    expect(badgeOf("healthy", false, []).label).toBe("Healthy");
  });

  it("paints every blocking problem red, whatever its type", () => {
    for (const types of [["payment_problem"], ["other"], ["a", "b"]]) {
      expect(badgeOf("healthy", true, types).className).toContain("text-danger");
    }
  });
});

describe("a problem needs only an account and a type (M03)", () => {
  const accountId = "11111111-1111-4111-8111-111111111111";

  it("accepts a report with no severity and no description, defaulting both", () => {
    const parsed = createProblemSchema.safeParse({ accountId, issueType: "payment_problem" });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ severity: "medium", description: "" });
  });

  it("still validates the fields when a caller sends them", () => {
    expect(
      createProblemSchema.safeParse({ accountId, issueType: "other", severity: "urgent" }).success,
    ).toBe(false);
    expect(
      createProblemSchema.safeParse({
        accountId,
        issueType: "other",
        description: "x".repeat(2001),
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown problem type — no new categories", () => {
    expect(createProblemSchema.safeParse({ accountId, issueType: "slow" }).success).toBe(false);
  });
});

describe("the profile editor sends only what changed", () => {
  const initial = {
    profileName: "Kids",
    pin: "1234",
    notes: "Old note",
    customerPhone: "0663 94 71 16",
    saleDate: "2026-09-01",
    durationDays: "30",
  };

  it("sends nothing when nothing changed", () => {
    expect(buildProfileEditPayload(initial, initial, true)).toEqual({});
  });

  it("a notes-only edit carries no sale date or duration — it is not an allocation change", () => {
    expect(buildProfileEditPayload({ ...initial, notes: "New note" }, initial, true)).toEqual({
      notes: "New note",
    });
  });

  it("clearing a note sends an empty note, which is how a note is removed", () => {
    expect(buildProfileEditPayload({ ...initial, notes: "" }, initial, true)).toEqual({
      notes: "",
    });
  });

  it("sends a changed duration as a number, and a changed sale date as given", () => {
    expect(
      buildProfileEditPayload(
        { ...initial, durationDays: "60", saleDate: "2026-09-05" },
        initial,
        true,
      ),
    ).toEqual({ durationDays: 60, saleDate: "2026-09-05" });
  });

  it("never sends an expiration date — the server derives it", () => {
    const payload = buildProfileEditPayload(
      { ...initial, expirationDate: "2030-01-01", durationDays: "60" },
      initial,
      true,
    );
    expect(payload).not.toHaveProperty("expirationDate");
  });

  it("leaves allocation fields alone on a slot that cannot hold one", () => {
    expect(
      buildProfileEditPayload({ ...initial, saleDate: "2026-09-05", pin: "4321" }, initial, false),
    ).toEqual({ pin: "4321" });
  });

  it("treats a blanked name or PIN as 'leave it alone', not as a clear", () => {
    expect(
      buildProfileEditPayload({ ...initial, profileName: "", pin: "" }, initial, true),
    ).toEqual({});
  });
});

describe("the expiration the editor shows is the one the server writes", () => {
  const stored = { saleDate: "2026-09-01", durationDays: 30, expirationDate: "2026-10-01" };

  it.each([
    ["nothing changed", {}, "2026-10-01"],
    ["the duration changed", { durationDays: "60" }, "2026-10-31"],
    ["the sale date changed", { saleDate: "2026-09-11" }, "2026-10-11"],
    ["both changed", { saleDate: "2026-09-11", durationDays: "90" }, "2026-12-10"],
    [
      "a field was blanked, which means unchanged",
      { saleDate: "", durationDays: "" },
      "2026-10-01",
    ],
  ])("when %s", (_label, form, expected) => {
    expect(previewExpirationDate(form, stored)).toBe(expected);
  });

  it("corrects a stale stored expiration exactly as the server would", () => {
    const stale = { ...stored, expirationDate: "2027-05-05" };

    expect(previewExpirationDate({}, stale)).toBe("2026-10-01");
    expect(previewExpirationDate({}, stale)).toBe(
      resolveExpirationDate(stale.saleDate, stale.durationDays, stale.expirationDate),
    );
  });

  it("keeps the stored expiration when there is no duration to derive from", () => {
    const noDuration = { saleDate: "2026-09-01", durationDays: null, expirationDate: "2026-12-31" };

    expect(previewExpirationDate({ saleDate: "2026-09-05" }, noDuration)).toBe("2026-12-31");
  });

  it("shows nothing for a profile with no sale date and no expiration", () => {
    expect(
      previewExpirationDate(
        { durationDays: "30" },
        { saleDate: null, durationDays: null, expirationDate: null },
      ),
    ).toBe("");
  });

  it("an invalid typed duration falls back to what is stored, as the server would refuse it", () => {
    expect(previewExpirationDate({ durationDays: "abc" }, stored)).toBe("2026-10-01");
  });
});
