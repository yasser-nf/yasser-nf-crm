import { readFile } from "node:fs/promises";

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { accountMatchesStatusSql } from "@/lib/drizzle/predicates";
import type { AccountRow } from "@/lib/drizzle/schema";
import { accountBadgeStyle } from "@/modules/accounts/components/status-badge";
import {
  accountCanAllocate,
  accountEffectiveStatus,
} from "@/modules/accounts/services/account-validity";

/**
 * Resolving a problem does not make an account Healthy (M03 final fix).
 *
 * The badge used to say Healthy whenever the stored status was healthy and no
 * problem was open. An account whose own validity had ended therefore turned
 * Healthy the moment its last problem was resolved, while every allocating
 * screen still refused it. `accountEffectiveStatus` now recalculates from every
 * remaining fact and returns "healthy" exactly when `accountCanAllocate` does.
 */

const TODAY = new Date("2026-09-24T12:00:00Z");
const STATUSES: AccountRow["status"][] = [
  "healthy",
  "payment_problem",
  "incorrect_password",
  "invalid_email",
  "something_went_wrong",
  "archived",
  "deleted",
];

function account(
  status: AccountRow["status"],
  validUntil: string | null = null,
  deletedAt: Date | null = null,
) {
  return { status, validUntil, deletedAt };
}

describe("3–4. Healthy means exactly what allocation means", () => {
  it("agrees with accountCanAllocate for every combination of facts", () => {
    const validities = [null, "2026-12-31", "2026-09-24", "2026-09-23", "2025-01-01"];
    const problemSets = [[], ["payment_problem"], ["payment_problem", "invalid_email"], ["other"]];
    const deletions = [null, new Date("2026-09-01")];
    let checked = 0;

    for (const status of STATUSES) {
      for (const validUntil of validities) {
        for (const problems of problemSets) {
          for (const deletedAt of deletions) {
            const a = account(status, validUntil, deletedAt);
            const effective = accountEffectiveStatus(a, problems, TODAY);
            const allocatable = accountCanAllocate(a, problems.length > 0, TODAY);

            expect(effective === "healthy", JSON.stringify({ a, problems })).toBe(allocatable);
            expect(accountBadgeStyle(effective).label === "Healthy").toBe(allocatable);
            checked += 1;
          }
        }
      }
    }

    expect(checked).toBe(STATUSES.length * 5 * 4 * 2);
  });
});

describe("the state after the last problem is resolved is recalculated, not assumed", () => {
  it("1. a genuinely healthy account with nothing left open is Healthy", () => {
    expect(accountEffectiveStatus(account("healthy", "2026-12-31"), [], TODAY)).toBe("healthy");
    expect(accountEffectiveStatus(account("healthy"), [], TODAY)).toBe("healthy");
  });

  it("3. an account whose own validity has ended is Expired, not Healthy", () => {
    const effective = accountEffectiveStatus(account("healthy", "2026-09-23"), [], TODAY);

    expect(effective).toBe("expired");
    expect(accountBadgeStyle(effective).label).toBe("Expired");
  });

  it("expires after its last day, not on it", () => {
    expect(accountEffectiveStatus(account("healthy", "2026-09-24"), [], TODAY)).toBe("healthy");
  });

  it("3. a stored fault is still that fault once the problem is resolved", () => {
    expect(accountEffectiveStatus(account("invalid_email"), [], TODAY)).toBe("invalid_email");
    expect(accountEffectiveStatus(account("archived"), [], TODAY)).toBe("archived");
  });

  it("2. with another blocking problem left it is that problem, never Healthy", () => {
    expect(accountEffectiveStatus(account("healthy"), ["invalid_email"], TODAY)).toBe(
      "invalid_email",
    );
    expect(
      accountEffectiveStatus(account("healthy"), ["invalid_email", "payment_problem"], TODAY),
    ).toBe("problem");
    expect(accountEffectiveStatus(account("healthy"), ["other"], TODAY)).toBe("problem");
  });
});

describe("the Healthy filter asks the same questions", () => {
  it("requires the stored status, no blocking problem, AND coverage", () => {
    const query = new PgDialect().sqlToQuery(accountMatchesStatusSql("healthy"));

    expect(query.sql).toContain("not exists");
    expect(query.sql).toContain("valid_until");
    expect(query.sql).toContain("current_date");
  });
});

describe("8. no resolve path writes an account's status", () => {
  it.each([
    "src/modules/problems/services/problem-resolution.service.ts",
    "src/modules/problems/services/bulk-problems.service.ts",
    "src/modules/problems/services/problems.service.ts",
    "src/modules/problems/actions/problem.actions.ts",
    "src/modules/problems/repositories/problems.repository.ts",
  ])("%s never updates accounts or sets a status to healthy", async (file) => {
    const source = await readFile(file, "utf8");

    expect(source).not.toMatch(/update\(\s*accounts\b/);
    expect(source).not.toMatch(/status:\s*["']healthy["']/);
    expect(source).not.toContain("accountsRepository");
  });

  it("the badge decides nothing itself — it renders the derived status", async () => {
    const source = await readFile("src/modules/accounts/components/status-badge.tsx", "utf8");

    expect(source).toContain(
      "export function accountBadgeStyle(effective: AccountEffectiveStatus)",
    );
    expect(source).not.toMatch(/hasActiveProblem/);
  });
});
