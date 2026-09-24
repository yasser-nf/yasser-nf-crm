import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import { accountMatchesStatusSql } from "@/lib/drizzle/predicates";
import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";
import { accountBadgeStyle } from "@/modules/accounts/components/status-badge";
import { accountEffectiveStatus } from "@/modules/accounts/services/account-validity";
import {
  tallyProfileStates,
  type ProfileStateInput,
} from "@/modules/dashboard/services/profile-state-counts";

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
 * Dashboard counts derived from the same rules the Accounts page shows.
 *
 * M01 F4: "Healthy" counted `accounts.status = 'healthy'` while "With problems"
 * counted accounts with an open blocking issue. Problems never write the
 * status column (ADR-010 D4), so the same accounts were counted twice.
 *
 * M01 F5: "Expiring soon" and "Expired" counted `profiles.status` values that
 * nothing writes. They read 0 and 0 while the truth was 4 and 6.
 */

/* Pinned so "expiring soon" (≤ 3 days) and "expired" (< today) are exact. */
const TODAY = new Date("2026-09-24T12:00:00Z");

function account(overrides: Partial<AccountRow> = {}): ProfileStateInput["account"] {
  return {
    profileSlots: 5,
    validUntil: null,
    status: "healthy",
    deletedAt: null,
    ...overrides,
  };
}

function profile(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: "p",
    accountId: "a",
    profileNumber: 1,
    profileName: null,
    pin: null,
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
  } as ProfileRow;
}

const sold = (expirationDate: string) =>
  profile({ status: "sold", customerId: "c", saleDate: "2026-08-01", expirationDate });

const dialect = new PgDialect();
const healthySql = dialect.sqlToQuery(accountMatchesStatusSql("healthy")).sql;

describe("F4 — an account is Healthy or has a problem, never both", () => {
  it("1. a healthy account with no blocking problem is Healthy", () => {
    expect(badgeOf("healthy", false).label).toBe("Healthy");
  });

  it("2. a healthy account WITH a blocking problem is not Healthy", () => {
    /* Stored healthy, open problem: the Accounts page badges it Problem. */
    expect(badgeOf("healthy", true).label).toBe("Problem");
  });

  it("3. the dashboard's Healthy predicate excludes an account with a blocking problem", () => {
    /*
     * The dashboard now counts Healthy with accountMatchesStatusSql("healthy")
     * — the predicate the Accounts status filter uses — which requires BOTH the
     * stored status and the absence of an open, in-progress or waiting issue.
     */
    expect(healthySql).toContain(`"accounts"."status" =`);
    expect(healthySql).toContain("not exists");
    for (const blocking of ["open", "in_progress", "waiting"]) {
      expect(healthySql).toContain(`'${blocking}'`);
    }
  });

  it("uses that predicate, not the bare status column", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      "src/modules/dashboard/repositories/dashboard.repository.ts",
      "utf8",
    );

    expect(source).toContain(
      'count(*) filter (where ${accountMatchesStatusSql("healthy")})::int as healthy',
    );
    expect(source).not.toContain("count(*) filter (where status = 'healthy')::int as healthy");
  });
});

describe("F5 — profile buckets by display state", () => {
  it("4. counts an allocation inside the 3-day window as expiring soon", () => {
    const tally = tallyProfileStates(
      [{ profile: sold("2026-09-26"), account: account(), hasBlockingProblem: false }],
      TODAY,
    );

    expect(tally.expiring_soon).toBe(1);
    expect(tally.sold).toBe(0);
  });

  it("5. counts an allocation whose date has passed as expired", () => {
    const tally = tallyProfileStates(
      [{ profile: sold("2026-09-20"), account: account(), hasBlockingProblem: false }],
      TODAY,
    );

    expect(tally.expired).toBe(1);
  });

  it("5b. reads the date, not the status column nothing writes", () => {
    /* status stays 'sold' in the database; the date is what expired. */
    const stale = sold("2026-09-01");

    expect(stale.status).toBe("sold");
    expect(
      tallyProfileStates([{ profile: stale, account: account(), hasBlockingProblem: false }], TODAY)
        .expired,
    ).toBe(1);
  });

  it("6. counts a normal active allocation as sold", () => {
    const tally = tallyProfileStates(
      [{ profile: sold("2026-12-31"), account: account(), hasBlockingProblem: false }],
      TODAY,
    );

    expect(tally.sold).toBe(1);
    expect(tally.expiring_soon).toBe(0);
  });

  it("7. counts a free slot on a healthy account as available", () => {
    const tally = tallyProfileStates(
      [{ profile: profile(), account: account(), hasBlockingProblem: false }],
      TODAY,
    );

    expect(tally.available).toBe(1);
  });

  it("does NOT count a free slot on a problem account as available", () => {
    /* The allocation engine would refuse it; the widget must not advertise it. */
    const tally = tallyProfileStates(
      [{ profile: profile(), account: account(), hasBlockingProblem: true }],
      TODAY,
    );

    expect(tally.available).toBe(0);
    expect(tally.blocked).toBe(1);
  });

  it("counts a slot above profile_slots as not for sale", () => {
    const tally = tallyProfileStates(
      [
        {
          profile: profile({ profileNumber: 5 }),
          account: account({ profileSlots: 3 }),
          hasBlockingProblem: false,
        },
      ],
      TODAY,
    );

    expect(tally.not_for_sale).toBe(1);
  });
});

describe("the property the old counts lacked", () => {
  it("puts every profile in exactly one bucket", () => {
    const inputs: ProfileStateInput[] = [
      { profile: profile(), account: account(), hasBlockingProblem: false },
      { profile: profile(), account: account(), hasBlockingProblem: true },
      { profile: sold("2026-12-31"), account: account(), hasBlockingProblem: false },
      { profile: sold("2026-09-25"), account: account(), hasBlockingProblem: true },
      { profile: sold("2026-09-10"), account: account(), hasBlockingProblem: false },
      {
        profile: profile({ profileNumber: 5 }),
        account: account({ profileSlots: 2 }),
        hasBlockingProblem: false,
      },
      {
        profile: profile(),
        account: account({ status: "invalid_email" }),
        hasBlockingProblem: false,
      },
    ];

    const tally = tallyProfileStates(inputs, TODAY);
    const sum = Object.values(tally).reduce((a, b) => a + b, 0);

    expect(sum).toBe(inputs.length);
    expect(tally).toEqual({
      available: 1,
      blocked: 2,
      sold: 1,
      expiring_soon: 1,
      expired: 1,
      not_for_sale: 1,
    });
  });

  it("keeps a held allocation sold even when the account has a problem", () => {
    /* profileCellState never repaints a customer's allocation for an account fault. */
    const tally = tallyProfileStates(
      [{ profile: sold("2026-12-31"), account: account(), hasBlockingProblem: true }],
      TODAY,
    );

    expect(tally.sold).toBe(1);
    expect(tally.blocked).toBe(0);
  });
});

describe("no second implementation", () => {
  it("classifies through profileCellState and accountCanAllocate, nothing else", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/modules/dashboard/services/profile-state-counts.ts", "utf8");

    expect(source).toContain("profileCellState(profile, account, today, canAllocate)");
    expect(source).toContain("accountCanAllocate(account, hasBlockingProblem, today)");
    /* no date arithmetic or status comparisons of its own */
    expect(source).not.toMatch(/expirationDate\s*[<>]/);
    expect(source).not.toMatch(/status\s*===\s*"/);
  });

  it("no longer counts display states from profiles.status in SQL", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      "src/modules/dashboard/repositories/dashboard.repository.ts",
      "utf8",
    );

    for (const stale of [
      "'expiring_soon')::int",
      "p.status = 'expired'",
      "p.status = 'sold')::int",
    ]) {
      expect(source).not.toContain(stale);
    }
  });
});
