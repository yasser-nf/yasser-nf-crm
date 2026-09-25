import { describe, expect, it } from "vitest";

import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";
import { accountCanAllocate } from "@/modules/accounts/services/account-validity";
import {
  accountBucket,
  tallyAccountStates,
  type AccountStateInput,
} from "@/modules/dashboard/services/account-state-counts";
import {
  expirationBuckets,
  resellableExpired,
  tallyProfileStates,
  type ProfileStateInput,
} from "@/modules/dashboard/services/profile-state-counts";

/**
 * M04 — the dashboard's figures, as pure derivations.
 *
 * Account buckets come from `accountEffectiveStatus`, profile buckets from
 * `profileCellState`, expirations from the same classification in UTC days.
 * These tests pin the properties the dashboard promises: disjoint buckets that
 * sum to their totals, Healthy meaning allocatable, and date boundaries that do
 * not move with the time zone.
 */

const TODAY = new Date("2026-09-24T12:00:00Z");

function acct(
  status: AccountRow["status"] = "healthy",
  validUntil: string | null = null,
  blockingProblemTypes: string[] = [],
): AccountStateInput {
  return { account: { status, validUntil, deletedAt: null }, blockingProblemTypes };
}

/* ------------------------------------------------------------------ accounts */

describe("account buckets", () => {
  const MIX = [
    acct("healthy"),
    acct("healthy", "2026-12-31"),
    acct("healthy", null, ["payment_problem"]),
    acct("healthy", null, ["payment_problem", "invalid_email", "payment_problem"]),
    acct("healthy", "2026-09-01"),
    acct("healthy", "2026-09-01", ["other"]),
    acct("archived"),
    acct("archived", null, ["payment_problem"]),
    acct("incorrect_password"),
  ];

  it("4–6, 17. are disjoint and sum to the total", () => {
    const tally = tallyAccountStates(MIX, TODAY);

    expect(tally).toEqual({ total: 9, healthy: 2, problems: 4, expired: 1, archived: 2 });
    expect(tally.healthy + tally.problems + tally.expired + tally.archived).toBe(tally.total);
  });

  it("1. Healthy counts exactly the accounts accountCanAllocate would sell from", () => {
    const allocatable = MIX.filter(({ account, blockingProblemTypes }) =>
      accountCanAllocate(account, blockingProblemTypes.length > 0, TODAY),
    ).length;

    expect(tallyAccountStates(MIX, TODAY).healthy).toBe(allocatable);
  });

  it("2. an account with a blocking problem is a Problem, never Healthy", () => {
    expect(tallyAccountStates([acct("healthy", null, ["payment_problem"])], TODAY)).toMatchObject({
      healthy: 0,
      problems: 1,
    });
  });

  it("3. an expired account is Expired, never Healthy", () => {
    expect(tallyAccountStates([acct("healthy", "2026-09-23")], TODAY)).toMatchObject({
      healthy: 0,
      expired: 1,
    });
  });

  it("an expired account WITH a blocking problem is a Problem, counted once", () => {
    expect(tallyAccountStates([acct("healthy", "2026-09-23", ["other"])], TODAY)).toMatchObject({
      problems: 1,
      expired: 0,
      total: 1,
    });
  });

  it("a fault recorded on the account itself is a Problem", () => {
    expect(tallyAccountStates([acct("invalid_email")], TODAY).problems).toBe(1);
  });

  it("documented: an archived account with an open problem counts as Archived (M03 precedence)", () => {
    expect(tallyAccountStates([acct("archived", null, ["payment_problem"])], TODAY)).toMatchObject({
      archived: 1,
      problems: 0,
    });
  });

  it("maps every effective status to exactly one bucket", () => {
    expect(accountBucket("healthy")).toBe("healthy");
    expect(accountBucket("expired")).toBe("expired");
    expect(accountBucket("archived")).toBe("archived");
    expect(accountBucket("problem")).toBe("problems");
    expect(accountBucket("payment_problem")).toBe("problems");
    expect(accountBucket("deleted")).toBeNull();
  });
});

/* ------------------------------------------------------------------ profiles */

let seq = 0;

function prof(overrides: Partial<ProfileRow> = {}): ProfileRow {
  seq += 1;
  return {
    id: `p${seq}`,
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ProfileRow;
}

const held = (expirationDate: string) =>
  prof({ status: "sold", customerId: "c", saleDate: "2026-08-01", expirationDate });

function input(
  profile: ProfileRow,
  options: { blocked?: boolean; slots?: number; validUntil?: string | null } = {},
): ProfileStateInput {
  return {
    profile,
    account: {
      profileSlots: options.slots ?? 5,
      validUntil: options.validUntil ?? null,
      status: "healthy",
      deletedAt: null,
    },
    hasBlockingProblem: options.blocked ?? false,
  };
}

describe("profile buckets", () => {
  it("7. are disjoint: every profile lands in exactly one, summing to the total", () => {
    const inputs = [
      input(prof()),
      input(prof(), { blocked: true }),
      input(prof({ profileNumber: 5 }), { slots: 3 }),
      input(held("2026-12-31")),
      input(held("2026-09-26")),
      input(held("2026-09-01")),
    ];

    const tally = tallyProfileStates(inputs, TODAY);
    const sum = Object.values(tally).reduce((a, b) => a + b, 0);

    expect(sum).toBe(inputs.length);
    expect(tally).toEqual({
      available: 1,
      blocked: 1,
      not_for_sale: 1,
      sold: 1,
      expiring_soon: 1,
      expired: 1,
    });
  });

  it("8, 17. five free profiles on a blocked account are Blocked, not Available", () => {
    const five = [1, 2, 3, 4, 5].map((n) => input(prof({ profileNumber: n }), { blocked: true }));

    expect(tallyProfileStates(five, TODAY)).toMatchObject({ available: 0, blocked: 5 });
  });

  it("… and so are free profiles on an expired account", () => {
    expect(tallyProfileStates([input(prof(), { validUntil: "2026-09-01" })], TODAY)).toMatchObject({
      available: 0,
      blocked: 1,
    });
  });

  it("25. a sold profile whose date passes moves from Sold to Expired", () => {
    const profile = held("2026-09-24");

    expect(tallyProfileStates([input(profile)], TODAY).expiring_soon).toBe(1);
    expect(tallyProfileStates([input(profile)], new Date("2026-09-25T12:00:00Z")).expired).toBe(1);
  });

  it("an expired allocation on a working account is resellable (the recycling rule)", () => {
    expect(resellableExpired([input(held("2026-09-01"))], TODAY)).toBe(1);
    expect(resellableExpired([input(held("2026-09-01"), { blocked: true })], TODAY)).toBe(0);
    expect(resellableExpired([input(held("2026-12-31"))], TODAY)).toBe(0);
  });
});

/* --------------------------------------------------------------- expirations */

describe("expiration buckets", () => {
  function bucketsFor(expirationDate: string, today = TODAY) {
    return expirationBuckets([input(held(expirationDate))], today);
  }

  it.each([
    ["10. already expired (yesterday)", "2026-09-23", "expired"],
    ["expires today", "2026-09-24", "today"],
    ["expires tomorrow", "2026-09-25", "tomorrow"],
    ["exactly at the threshold (3 days)", "2026-09-27", "inTwoToThree"],
    ["one day above the threshold (4 days)", "2026-09-28", "inFourToSeven"],
    ["normal (30 days)", "2026-10-24", null],
  ])("%s lands in exactly one bucket", (_label, date, bucket) => {
    const buckets = bucketsFor(date);
    const hits = Object.entries(buckets).filter(([, n]) => n > 0);

    expect(hits.map(([key]) => key)).toEqual(bucket === null ? [] : [bucket]);
  });

  it("11–12. reconcile with the Profiles widget: Expiring soon = today + tomorrow + 2–3", () => {
    const inputs = [
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
    ].map((date) => input(held(date)));

    const tally = tallyProfileStates(inputs, TODAY);
    const buckets = expirationBuckets(inputs, TODAY);

    expect(buckets.today + buckets.tomorrow + buckets.inTwoToThree).toBe(tally.expiring_soon);
    expect(buckets.expired).toBe(tally.expired);
    /* 12. The expired one is not also expiring soon. */
    expect(tally.expiring_soon).toBe(4);
    expect(tally.expired).toBe(1);
  });

  it("ignores free slots: a date on an unsold profile is not an upcoming expiry", () => {
    const free = prof({ status: "available", expirationDate: "2026-09-25" });

    expect(expirationBuckets([input(free)], TODAY)).toMatchObject({ tomorrow: 0 });
  });

  it("20, 22. the day turns at UTC midnight, whatever the local clock says", () => {
    expect(bucketsFor("2026-09-24", new Date("2026-09-24T23:59:59Z")).today).toBe(1);
    expect(bucketsFor("2026-09-24", new Date("2026-09-25T00:00:00Z")).expired).toBe(1);
    /* 00:30 in UTC+1 is still the 24th in UTC: nothing has expired yet. */
    expect(bucketsFor("2026-09-24", new Date("2026-09-25T00:30:00+01:00")).today).toBe(1);
  });

  it("21. counts across a month boundary", () => {
    const endOfMonth = new Date("2026-09-30T12:00:00Z");

    expect(bucketsFor("2026-10-01", endOfMonth).tomorrow).toBe(1);
    expect(bucketsFor("2026-10-03", endOfMonth).inTwoToThree).toBe(1);
    expect(bucketsFor("2026-09-30", new Date("2026-10-01T00:00:00Z")).expired).toBe(1);
  });
});
