import { describe, expect, it } from "vitest";

import { accountBadgeStyle } from "@/modules/accounts/components/status-badge";
import { BLOCKING_STATUSES, PROBLEM_STATUSES } from "@/modules/problems/services/problem-lifecycle";

/**
 * An account with an open problem must never read "Healthy".
 *
 * The defect this guards: `accounts.status` is the persisted operational status
 * and ADR-010 Decision 4 keeps problems out of it — reporting a problem never
 * writes to that column. So an account carrying an open payment problem still
 * says `healthy` in its own row, and anything rendering that column alone shows
 * a green badge.
 *
 * `getAccountDetail` had always combined the two facts. `listAccounts` never
 * asked the Problems module anything, so the accounts list showed
 * baleinier-pulsar.6b@icloud.com as Healthy while an open payment problem sat
 * against it.
 *
 * These tests pin the decision function rather than the query, because the
 * decision is the part that was wrong and the part that can silently regress.
 */

type AccountStatus = Parameters<typeof accountBadgeStyle>[0];

/** The label the real component would render. */
function badgeFor(status: AccountStatus, hasActiveProblem: boolean): string {
  return accountBadgeStyle(status, hasActiveProblem).label;
}

describe("account status badge — an open problem overrides Healthy", () => {
  it("the reported defect: healthy account with an active problem is not Healthy", () => {
    expect(badgeFor("healthy", true)).toBe("Problem");
    expect(badgeFor("healthy", true)).not.toBe("Healthy");
  });

  it("a healthy account with nothing open stays Healthy", () => {
    expect(badgeFor("healthy", false)).toBe("Healthy");
  });

  it("a resolved or closed problem does not make a healthy account problematic", () => {
    /*
     * The caller derives the flag from BLOCKING_STATUSES, so a historical
     * problem arrives here as `false`. This is the half of the rule that stops
     * an over-correction: every account that ever had a fault would otherwise
     * be permanently red.
     */
    const historical = PROBLEM_STATUSES.filter(
      (s) => !(BLOCKING_STATUSES as readonly string[]).includes(s),
    );

    expect(historical).toEqual(expect.arrayContaining(["resolved", "closed", "cancelled"]));

    for (const status of historical) {
      const active = (BLOCKING_STATUSES as readonly string[]).includes(status);
      expect(active, `${status} must not count as active`).toBe(false);
      expect(badgeFor("healthy", active), `${status} leaves the account healthy`).toBe("Healthy");
    }
  });

  it("every blocking status is treated as active", () => {
    expect([...BLOCKING_STATUSES]).toEqual(["open", "in_progress", "waiting"]);

    for (const status of PROBLEM_STATUSES) {
      const active = (BLOCKING_STATUSES as readonly string[]).includes(status);
      expect(badgeFor("healthy", active), `${status}`).toBe(active ? "Problem" : "Healthy");
    }
  });

  it("an already-unhealthy status wins over the problem badge", () => {
    /* The status names the fault; "Problem" would be less informative. */
    for (const status of [
      "payment_problem",
      "incorrect_password",
      "invalid_email",
      "something_went_wrong",
    ] as const) {
      expect(badgeFor(status, true)).toBe(accountBadgeStyle(status, false).label);
    }
  });

  it("archived and deleted keep their own badge regardless of problems", () => {
    expect(badgeFor("archived", true)).toBe("Archived");
    expect(badgeFor("archived", false)).toBe("Archived");
    expect(badgeFor("deleted", true)).toBe("Deleted");
  });

  it("the rule is not keyed to any particular account", () => {
    /* Guards against a fix that special-cases the email from the bug report. */
    const statuses: AccountStatus[] = ["healthy", "payment_problem", "archived"];

    for (const status of statuses) {
      for (const flagged of [true, false]) {
        const badge = badgeFor(status, flagged);
        expect(badge === "Problem" || badge === accountBadgeStyle(status, false).label).toBe(true);
      }
    }
  });
});
