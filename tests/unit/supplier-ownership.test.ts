import { describe, expect, it } from "vitest";

import {
  tallySupplierOwnership,
  type SupplierAccountInput,
  type SupplierProfileInput,
} from "@/modules/dashboard";
import { accountBucket } from "@/modules/dashboard/services/account-state-counts";
import { accountEffectiveStatus } from "@/modules/accounts";
import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";

/**
 * The dashboard's ownership and per-supplier figures. M10 §13, §14, §15 and §16.
 *
 * Two properties are what these tests exist for:
 *
 *   OWNERSHIP IS FROM `supplier_id`, nothing else. M10 §15 says so explicitly,
 *   and forbids deriving it from profile ownership.
 *
 *   ACCOUNT AND PROFILE FIGURES NEVER MIX. M10 §13. A supplier with 2 accounts
 *   and 7 available profiles reports both, and neither contaminates the other.
 *
 * Pure, with an injected clock, so the boundary cases sit at fixed dates.
 */

const TODAY = new Date("2026-06-15T12:00:00Z");

const SUPPLIER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const SUPPLIER_B = "aaaaaaaa-0000-4000-8000-00000000000b";

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "acc-1",
    email: "stock@example.invalid",
    passwordEncrypted: "v1:a:b:c",
    status: "healthy",
    profileSlots: 5,
    validFrom: null,
    validUntil: null,
    country: "DZ",
    notes: null,
    supplierId: null,
    createdBy: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  } as AccountRow;
}

function profile(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: "pro-1",
    accountId: "acc-1",
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

/** An account input as the dashboard's own query now produces one. */
function input(
  supplierId: string | null,
  overrides: Partial<AccountRow> = {},
  blockingProblemTypes: readonly string[] = [],
): SupplierAccountInput {
  return { account: account(overrides), blockingProblemTypes, supplierId };
}

function profileInput(
  supplierId: string | null,
  profileOverrides: Partial<ProfileRow> = {},
  accountOverrides: Partial<AccountRow> = {},
  hasBlockingProblem = false,
): SupplierProfileInput {
  const owner = account(accountOverrides);

  return {
    profile: profile(profileOverrides),
    account: {
      profileSlots: owner.profileSlots,
      validUntil: owner.validUntil,
      status: owner.status,
      deletedAt: owner.deletedAt,
    },
    hasBlockingProblem,
    supplierId,
  };
}

describe("ownership — M10 §15", () => {
  it("counts My Accounts from supplier_id IS NULL and the rest from NOT NULL", () => {
    const tally = tallySupplierOwnership(
      [input(null), input(null), input(SUPPLIER_A), input(SUPPLIER_B), input(SUPPLIER_B)],
      [],
      TODAY,
    );

    expect(tally.myAccounts).toBe(2);
    expect(tally.supplierAccounts).toBe(3);
    expect(tally.totalAccounts).toBe(5);
  });

  it("totals the two, so the figure cannot disagree with its parts", () => {
    const tally = tallySupplierOwnership([input(null), input(SUPPLIER_A)], [], TODAY);

    expect(tally.totalAccounts).toBe(tally.myAccounts + tally.supplierAccounts);
  });

  it("is all My Accounts before any supplier exists — M10 §8 and §31", () => {
    /* Exactly the state the migration leaves: every account nullable and null. */
    const tally = tallySupplierOwnership([input(null), input(null), input(null)], [], TODAY);

    expect(tally.myAccounts).toBe(3);
    expect(tally.supplierAccounts).toBe(0);
    expect(tally.bySupplier).toHaveLength(1);
    expect(tally.bySupplier[0]?.supplierId).toBeNull();
  });

  it("is zero everywhere with no accounts at all", () => {
    const tally = tallySupplierOwnership([], [], TODAY);

    expect(tally).toMatchObject({ myAccounts: 0, supplierAccounts: 0, totalAccounts: 0 });
    expect(tally.bySupplier).toEqual([]);
  });

  it("does not count a soft-deleted account in either bucket", () => {
    const tally = tallySupplierOwnership(
      [
        input(SUPPLIER_A),
        input(SUPPLIER_A, { deletedAt: new Date("2026-05-01"), status: "deleted" }),
      ],
      [],
      TODAY,
    );

    expect(tally.supplierAccounts).toBe(1);
    expect(tally.totalAccounts).toBe(1);
  });
});

describe("per-supplier account buckets — M10 §12 and §16", () => {
  it("classifies by the same rule as every account badge", () => {
    const rows = tallySupplierOwnership(
      [
        input(SUPPLIER_A),
        input(SUPPLIER_A, { validUntil: "2026-01-01" }),
        input(SUPPLIER_A, { status: "payment_problem" }),
        input(SUPPLIER_A, {}, ["payment_problem"]),
        input(SUPPLIER_A, { status: "archived" }),
      ],
      [],
      TODAY,
    ).bySupplier;

    const a = rows.find((row) => row.supplierId === SUPPLIER_A);

    expect(a).toMatchObject({
      totalAccounts: 5,
      healthyAccounts: 1,
      expiredAccounts: 1,
      /* A stored fault AND a blocking problem are both "problems". */
      problemAccounts: 2,
      archivedAccounts: 1,
    });
  });

  it("counts a blocking problem as a problem, never a single historical one", () => {
    /*
     * M10 §16. `blockingProblemTypes` carries only problems in a BLOCKING
     * status — the Problems module decides that, and an account whose problem
     * was resolved arrives with an empty list.
     */
    const resolved = tallySupplierOwnership([input(SUPPLIER_A, {}, [])], [], TODAY).bySupplier[0];

    expect(resolved).toMatchObject({ problemAccounts: 0, healthyAccounts: 1 });
  });

  it("buckets sum to the total for every supplier", () => {
    const rows = tallySupplierOwnership(
      [
        input(null),
        input(null, { status: "archived" }),
        input(SUPPLIER_A, { validUntil: "2026-01-01" }),
        input(SUPPLIER_A, {}, ["invalid_email"]),
        input(SUPPLIER_B),
      ],
      [],
      TODAY,
    ).bySupplier;

    for (const row of rows) {
      expect(
        row.healthyAccounts + row.problemAccounts + row.expiredAccounts + row.archivedAccounts,
      ).toBe(row.totalAccounts);
    }
  });

  it("agrees with accountEffectiveStatus row by row", () => {
    /*
     * The strongest form of "no second definition": the bucket a row lands in
     * is the bucket `accountBucket(accountEffectiveStatus(...))` names.
     */
    const cases: readonly { account: Partial<AccountRow>; problems: readonly string[] }[] = [
      { account: {}, problems: [] },
      { account: { validUntil: "2026-01-01" }, problems: [] },
      { account: {}, problems: ["payment_problem"] },
      { account: { status: "archived" }, problems: [] },
      { account: { status: "archived" }, problems: ["payment_problem"] },
      { account: { status: "something_went_wrong" }, problems: [] },
    ];

    for (const entry of cases) {
      const rows = tallySupplierOwnership(
        [input(SUPPLIER_A, entry.account, entry.problems)],
        [],
        TODAY,
      ).bySupplier;

      const bucket = accountBucket(
        accountEffectiveStatus(account(entry.account), entry.problems, TODAY),
      );

      const field =
        bucket === "problems"
          ? "problemAccounts"
          : bucket === "healthy"
            ? "healthyAccounts"
            : bucket === "expired"
              ? "expiredAccounts"
              : "archivedAccounts";

      expect(rows[0]?.[field]).toBe(1);
    }
  });
});

describe("available profiles — M10 §12 and §13", () => {
  it("counts free sellable slots on allocatable accounts", () => {
    const tally = tallySupplierOwnership(
      [input(SUPPLIER_A)],
      [
        profileInput(SUPPLIER_A, { profileNumber: 1 }),
        profileInput(SUPPLIER_A, { profileNumber: 2 }),
      ],
      TODAY,
    );

    expect(tally.bySupplier[0]?.availableProfiles).toBe(2);
  });

  it("excludes a slot above profile_slots — not stock", () => {
    const tally = tallySupplierOwnership(
      [input(SUPPLIER_A, { profileSlots: 2 })],
      [
        profileInput(SUPPLIER_A, { profileNumber: 2 }, { profileSlots: 2 }),
        profileInput(SUPPLIER_A, { profileNumber: 5 }, { profileSlots: 2 }),
      ],
      TODAY,
    );

    expect(tally.bySupplier[0]?.availableProfiles).toBe(1);
  });

  it("excludes a live sale, and includes one whose allocation lapsed", () => {
    /* The recycling rule: an expired allocation on a healthy account is stock. */
    const tally = tallySupplierOwnership(
      [input(SUPPLIER_A)],
      [
        profileInput(SUPPLIER_A, {
          profileNumber: 1,
          status: "sold",
          customerId: "cus-1",
          expirationDate: "2026-12-01",
        }),
        profileInput(SUPPLIER_A, {
          profileNumber: 2,
          status: "sold",
          customerId: "cus-2",
          expirationDate: "2026-01-01",
        }),
      ],
      TODAY,
    );

    /*
     * One: the lapsed allocation, which 03_DATABASE.md's recycling rule makes
     * stock again on a healthy account, and which Quick Prepare will allocate.
     * The live sale is not.
     *
     * This is the figure M10 §12 asks for — "available/allocable according to
     * the existing profile eligibility rules" — and it is the same number the
     * supplier's own page shows, because that page composes the SQL twins of
     * the same three predicates.
     */
    expect(tally.bySupplier[0]?.availableProfiles).toBe(1);
  });

  it("excludes every profile on a blocked account — 01_MASTER_RULES", () => {
    const tally = tallySupplierOwnership(
      [input(SUPPLIER_A, {}, ["payment_problem"])],
      [
        profileInput(SUPPLIER_A, { profileNumber: 1 }, {}, true),
        profileInput(SUPPLIER_A, { profileNumber: 2 }, {}, true),
      ],
      TODAY,
    );

    expect(tally.bySupplier[0]?.availableProfiles).toBe(0);
    expect(tally.bySupplier[0]?.problemAccounts).toBe(1);
  });

  it("keeps account figures and profile figures apart — M10 §13", () => {
    const tally = tallySupplierOwnership(
      [input(SUPPLIER_A), input(SUPPLIER_A)],
      [
        profileInput(SUPPLIER_A, { profileNumber: 1 }),
        profileInput(SUPPLIER_A, { profileNumber: 2 }),
        profileInput(SUPPLIER_A, { profileNumber: 3 }),
      ],
      TODAY,
    );

    const row = tally.bySupplier[0];

    /* Two accounts and three available profiles. Different units, both reported. */
    expect(row?.totalAccounts).toBe(2);
    expect(row?.availableProfiles).toBe(3);
  });

  it("attributes profiles to the supplier of their own account", () => {
    const tally = tallySupplierOwnership(
      [input(SUPPLIER_A), input(SUPPLIER_B), input(null)],
      [
        profileInput(SUPPLIER_A, { profileNumber: 1 }),
        profileInput(SUPPLIER_B, { profileNumber: 1 }),
        profileInput(SUPPLIER_B, { profileNumber: 2 }),
        profileInput(null, { profileNumber: 1 }),
      ],
      TODAY,
    );

    const byId = new Map(tally.bySupplier.map((row) => [row.supplierId, row]));

    expect(byId.get(SUPPLIER_A)?.availableProfiles).toBe(1);
    expect(byId.get(SUPPLIER_B)?.availableProfiles).toBe(2);
    expect(byId.get(null)?.availableProfiles).toBe(1);
  });
});
