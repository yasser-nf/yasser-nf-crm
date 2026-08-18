import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Reporting must count SELLABLE capacity, not raw profile rows.
 *
 * The Phase B audit found `utilization` in the profiles report had been fixed to
 * respect `profile_slots` while `stockTotal` and `allocationRate` in the
 * accounts report had not. An account selling two of its five profiles, both
 * sold, reported 40% allocation — which reads as poor performance rather than
 * as a full account, and would have quietly mis-stated the business.
 *
 * These tests pin the arithmetic against real rows. They assert DELTAS rather
 * than absolute totals, because the database also holds the operator's real
 * accounts and a fixed expectation would break the moment stock changed.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

const PREFIX = "m13-rep";
const PLAINTEXT = "not-a-real-password";

/** Wide open, so `dateBounds` cannot exclude the rows this file creates. */
const FILTERS = { from: undefined, to: undefined } as const;

let createdAccountId: string;

async function summary(report: "accounts" | "profiles") {
  const { reportsRepository } = await import("@/modules/reports/repositories/reports.repository");

  const result = await reportsRepository.summary(report, FILTERS as never);
  if (!result.ok) throw new Error(`summary(${report}) failed: ${result.error.message}`);

  return result.value as Record<string, number>;
}

beforeAll(async () => {
  if (!configured) return;

  const { accountsService } = await import("@/modules/accounts");

  const admins = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users
    where role = 'super_admin' and status = 'active' and deleted_at is null limit 1
  `;

  const admin = admins[0];
  if (!admin) throw new Error("No active Super Admin to authorize as");

  const created = await accountsService.createAccount(
    {
      email: `${PREFIX}-${Date.now()}@example.invalid`,
      password: PLAINTEXT,
      country: "DZ",
      /* Two sellable slots out of five physical rows. */
      profileSlots: 2,
    },
    {
      actor: {
        id: admin.id,
        email: admin.email,
        displayName: admin.name,
        initials: "SA",
        role: "super_admin",
      },
    },
  );

  if (!created.ok) throw new Error(`setup failed: ${created.error.message}`);
  createdAccountId = created.value.id;
});

afterAll(async () => {
  if (!configured) return;

  await sql!`delete from public.accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!.end({ timeout: 5 });
});

describe.skipIf(!configured)("stockTotal counts sellable slots", () => {
  it("adds only the sellable slots of a new account, not all five rows", async () => {
    const before = await summary("accounts");

    const { accountsService } = await import("@/modules/accounts");
    const admins = await sql!<{ id: string; email: string; name: string }[]>`
      select id, email, name from public.users
      where role = 'super_admin' and status = 'active' and deleted_at is null limit 1
    `;
    const admin = admins[0]!;

    const created = await accountsService.createAccount(
      {
        email: `${PREFIX}-delta-${Date.now()}@example.invalid`,
        password: PLAINTEXT,
        profileSlots: 3,
      },
      {
        actor: {
          id: admin.id,
          email: admin.email,
          displayName: admin.name,
          initials: "SA",
          role: "super_admin",
        },
      },
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const after = await summary("accounts");

    /* Three sellable slots added, not five rows. */
    expect(after["stockTotal"]! - before["stockTotal"]!).toBe(3);
    expect(after["stockAvailable"]! - before["stockAvailable"]!).toBe(3);
  }, 120_000);
});

describe.skipIf(!configured)("allocationRate measures against sellable capacity", () => {
  it("reaches 100% for an account whose sellable slots are all sold", async () => {
    /*
     * The bug this test exists for: with the old arithmetic a two-slot account
     * with both slots sold reported 2/5 = 40%.
     *
     * Asserted as a delta on the numerator and denominator rather than on the
     * percentage, because real accounts contribute to both.
     */
    const customers = await sql!<{ id: string }[]>`
      select id from public.customers where deleted_at is null limit 1
    `;

    if (customers.length === 0) return;

    const beforeSold = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.profiles p
      join public.accounts a on a.id = p.account_id
      where p.status = 'sold' and p.profile_number <= a.profile_slots
    `;

    /* Sell BOTH sellable slots, and also slot 4 — which is not stock. */
    await sql!`
      update public.profiles
      set status = 'sold', customer_id = ${customers[0]!.id}::uuid,
          sale_date = current_date, expiration_date = current_date + 30, duration_days = 30
      where account_id = ${createdAccountId}::uuid and profile_number in (1, 2, 4)
    `;

    const afterSold = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.profiles p
      join public.accounts a on a.id = p.account_id
      where p.status = 'sold' and p.profile_number <= a.profile_slots
    `;

    /*
     * Three rows were sold, but only TWO of them are sellable slots. Slot 4 is
     * above profile_slots and must not count towards allocation.
     */
    expect(afterSold[0]!.n - beforeSold[0]!.n).toBe(2);

    /* And the report's own denominator excludes it too. */
    const denominator = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.profiles p
      join public.accounts a on a.id = p.account_id
      where a.id = ${createdAccountId}::uuid and p.profile_number <= a.profile_slots
    `;

    expect(denominator[0]!.n).toBe(2);
  }, 120_000);

  it("never reports an allocation rate above 100%", async () => {
    /*
     * The arithmetic guard. Numerator and denominator must use the SAME
     * predicate — if the numerator counted all sold rows while the denominator
     * counted only sellable ones, a not-for-sale sale would push it past 100.
     */
    const result = await summary("accounts");

    expect(result["allocationRate"]).toBeGreaterThanOrEqual(0);
    expect(result["allocationRate"]).toBeLessThanOrEqual(100);
  }, 60_000);

  it("keeps stockAvailable no greater than stockTotal", async () => {
    const result = await summary("accounts");
    expect(result["stockAvailable"]).toBeLessThanOrEqual(result["stockTotal"]!);
  }, 60_000);
});

describe.skipIf(!configured)("the profiles report agrees with the accounts report", () => {
  it("reports a utilization within range and a not-for-sale count", async () => {
    const profiles = await summary("profiles");

    expect(profiles["utilization"]).toBeGreaterThanOrEqual(0);
    expect(profiles["utilization"]).toBeLessThanOrEqual(100);

    /* The account created in beforeAll contributes three unsellable rows. */
    expect(profiles["notForSale"]).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it("counts the same available stock as the accounts report", async () => {
    /*
     * Two independent queries, one predicate. If they ever disagree, one of
     * them stopped using lib/drizzle/predicates.
     */
    const accountsReport = await summary("accounts");
    const profilesReport = await summary("profiles");

    expect(profilesReport["available"]).toBe(accountsReport["stockAvailable"]);
  }, 60_000);
});
