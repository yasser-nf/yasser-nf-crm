import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * An account with an open problem contributes no stock.
 *
 * The rule itself was never in doubt — 01_MASTER_RULES.md states it, and the
 * Quick Prepare engine has always enforced it. The defect was that the engine
 * was the ONLY place that did. The accounts list and the dashboard applied the
 * profile half of the rule and skipped the account half, so an account carrying
 * an open payment problem advertised four available profiles that Quick Prepare
 * would refuse to allocate. The dashboard said five available; the engine could
 * hand out one.
 *
 * These tests assert the two halves now agree, which is the property that broke.
 * They work in deltas against a baseline measured moments earlier, so they say
 * nothing about rows they did not create.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

const PREFIX = "p5-block";

let superAdmin: AppUser;

function email(tag: string): string {
  return `${PREFIX}-${tag}-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.invalid`;
}

async function services() {
  const { accountsService } = await import("@/modules/accounts");
  const { dashboardService } = await import("@/modules/dashboard");
  const { quickPrepareService } = await import("@/modules/quick-prepare");
  return { accountsService, dashboardService, quickPrepareService };
}

/** `slots` decides how many of the five rows are sellable. */
async function makeAccount(tag: string, slots = 5): Promise<{ id: string; email: string }> {
  const { accountsService } = await services();
  const address = email(tag);

  const result = await accountsService.createAccount(
    { email: address, password: "not-a-real-password", country: "DZ", profileSlots: slots },
    { actor: superAdmin },
  );

  if (!result.ok) throw new Error(`could not create ${tag}: ${result.error.message}`);
  return { id: result.value.id, email: address };
}

async function openProblem(accountId: string): Promise<void> {
  await sql!`
    insert into public.issues (account_id, issue_type, status, severity, description, reported_by)
    values (${accountId}::uuid, 'payment_problem', 'open', 'medium',
            ${`${PREFIX} fixture`}, ${superAdmin.id}::uuid)`;
}

async function softDelete(accountId: string): Promise<void> {
  await sql!`update public.accounts set status = 'deleted', deleted_at = now()
             where id = ${accountId}::uuid`;
}

async function sellProfile(accountId: string, profileNumber: number): Promise<void> {
  const digits = String(Math.floor(600_000_000 + Math.random() * 99_999_999));

  const customer = await sql!<{ id: string }[]>`
    insert into public.customers (name, phone_original, phone_normalized, whatsapp_url)
    values (${`${PREFIX}-cust`}, ${`+213${digits}`}, ${digits}, ${`https://wa.me/213${digits}`})
    returning id`;

  await sql!`
    update public.profiles
    set status = 'sold', customer_id = ${customer[0]!.id}::uuid,
        sale_date = current_date, expiration_date = current_date + 90, duration_days = 90
    where account_id = ${accountId}::uuid and profile_number = ${profileNumber}::smallint`;
}

/** The accounts list's own view of this row. */
async function listRow(accountId: string) {
  const { accountsService } = await services();
  const page = await accountsService.listAccounts({ limit: 200 });
  if (!page.ok) throw new Error(`list failed: ${page.error.message}`);
  return page.value.items.find((row) => row.account.id === accountId);
}

async function dashboardAvailable(): Promise<number> {
  const { dashboardService } = await services();
  const result = await dashboardService.load(superAdmin);
  if (!result.ok) throw new Error(`dashboard failed: ${result.error.message}`);
  return result.value.counts.profiles.available;
}

/**
 * Account ids Quick Prepare would actually draw from.
 *
 * Sized to the stock that exists: asking for more than is available makes
 * `preview` fail outright, and an empty result would then look like proof of
 * exclusion when it is really just an error. Requesting everything available
 * spreads the plan across every eligible account, which is what makes the
 * absence of an account meaningful.
 */
async function quickPrepareCandidates(): Promise<Set<string>> {
  const { quickPrepareService } = await services();

  const stock = await dashboardAvailable();
  if (stock === 0) return new Set();

  const preview = await quickPrepareService.preview({
    profileCount: Math.min(stock, 20),
    durationDays: 30,
  });

  if (!preview.ok)
    throw new Error(`preview failed with ${stock} in stock: ${preview.error.message}`);
  return new Set(preview.value.accounts.map((a) => a.accountId));
}

beforeAll(async () => {
  if (!configured) return;

  const admins = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users
    where role = 'super_admin' and status = 'active' and deleted_at is null limit 1`;

  const admin = admins[0];
  if (!admin) throw new Error("No active Super Admin to authorize as");

  superAdmin = {
    id: admin.id,
    email: admin.email,
    displayName: admin.name,
    initials: "SA",
    role: "super_admin",
  };
}, 120_000);

afterAll(async () => {
  if (!configured) return;

  const owned = sql!`select id from public.accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!`delete from public.profile_events where profile_id in (
    select id from public.profiles where account_id in (${owned}))`;
  await sql!`delete from public.issues where account_id in (${owned})`;
  await sql!`update public.profiles set status = 'available', customer_id = null,
    sale_date = null, expiration_date = null, duration_days = null
    where customer_id in (select id from public.customers where name like ${`${PREFIX}-%`})`;
  await sql!`delete from public.customers where name like ${`${PREFIX}-%`}`;
  await sql!`delete from public.accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!.end({ timeout: 5 });
});

describe.skipIf(!configured)("an account with an open problem contributes no stock", () => {
  it("Test 1: healthy account + available profile → counted as available", async () => {
    const before = await dashboardAvailable();
    const account = await makeAccount("t1-healthy", 2);

    const row = await listRow(account.id);
    expect(row?.availableProfiles, "the list counts its stock").toBe(2);
    expect(await dashboardAvailable(), "and so does the dashboard").toBe(before + 2);
  }, 180_000);

  it("Test 2: problem account + available profile → NOT available", async () => {
    const account = await makeAccount("t2-problem", 2);
    const withStock = await dashboardAvailable();
    expect((await listRow(account.id))?.availableProfiles).toBe(2);

    await openProblem(account.id);

    expect((await listRow(account.id))?.availableProfiles, "the list stops counting it").toBe(0);
    expect(await dashboardAvailable(), "and the dashboard drops by exactly its stock").toBe(
      withStock - 2,
    );
  }, 180_000);

  it("Test 3: problem account + sold profile → the sale is untouched", async () => {
    const account = await makeAccount("t3-sold", 5);
    await sellProfile(account.id, 1);
    await openProblem(account.id);

    const sold = await sql!<{ status: string; customer_id: string | null }[]>`
      select status, customer_id from public.profiles
      where account_id = ${account.id}::uuid and profile_number = 1`;

    expect(sold[0]!.status, "still sold").toBe("sold");
    expect(sold[0]!.customer_id, "still theirs").not.toBeNull();

    const row = await listRow(account.id);
    expect(row?.soldProfiles, "and still reported as sold").toBe(1);
    expect(row?.availableProfiles, "while none of it is offered as stock").toBe(0);
  }, 180_000);

  it("Test 4: every available profile on a problem account is excluded", async () => {
    const account = await makeAccount("t4-many", 5);
    expect((await listRow(account.id))?.availableProfiles).toBe(5);

    await openProblem(account.id);

    expect((await listRow(account.id))?.availableProfiles, "all five withheld").toBe(0);
  }, 180_000);

  it("Test 5: mixed accounts count only the healthy one's stock", async () => {
    const before = await dashboardAvailable();

    const healthy = await makeAccount("t5-healthy", 2);
    const problem = await makeAccount("t5-problem", 3);
    await openProblem(problem.id);

    expect(await dashboardAvailable(), "2 from the healthy account, not 5").toBe(before + 2);
    expect((await listRow(healthy.id))?.availableProfiles).toBe(2);
    expect((await listRow(problem.id))?.availableProfiles).toBe(0);
  }, 180_000);

  it("Test 6: Quick Prepare never selects from an account with an open problem", async () => {
    const account = await makeAccount("t6-qp", 5);
    expect(await quickPrepareCandidates(), "selectable while healthy").toContain(account.id);

    await openProblem(account.id);

    expect(await quickPrepareCandidates(), "and gone once a problem is open").not.toContain(
      account.id,
    );
  }, 180_000);

  it("Test 7: Dashboard Available matches the rule Quick Prepare allocates by", async () => {
    const account = await makeAccount("t7-agree", 4);
    await openProblem(account.id);

    /*
     * The property that actually broke: the dashboard advertising stock the
     * engine would refuse. Compared in SQL against the engine's own predicate
     * rather than against a hard-coded number.
     */
    const engineEligible = await sql!<{ n: number }[]>`
      select count(*)::int as n
      from public.profiles p
      join public.accounts a on a.id = p.account_id
      where p.status = 'available'
        and p.profile_number <= a.profile_slots
        and a.status = 'healthy'
        and a.deleted_at is null
        and (a.valid_until is null or a.valid_until >= current_date)
        and not exists (
          select 1 from public.issues bi
          where bi.account_id = a.id and bi.status in ('open', 'in_progress', 'waiting')
        )`;

    expect(await dashboardAvailable(), "dashboard equals engine eligibility").toBe(
      engineEligible[0]!.n,
    );
  }, 180_000);

  it("Test 8: a soft-deleted account's profiles stay excluded", async () => {
    const account = await makeAccount("t8-deleted", 3);
    const withStock = await dashboardAvailable();

    await softDelete(account.id);

    expect(await dashboardAvailable(), "its stock leaves the count").toBe(withStock - 3);
    expect(await quickPrepareCandidates(), "and the engine cannot see it").not.toContain(
      account.id,
    );
  }, 180_000);

  it("a free slot on a blocked account is labelled blocked, not available", async () => {
    const account = await makeAccount("indicator", 3);
    expect((await listRow(account.id))?.indicators.map((i) => i.state)).toContain("available");

    await openProblem(account.id);

    const states = (await listRow(account.id))?.indicators.map((i) => i.state) ?? [];
    expect(states, "no slot still claims to be available").not.toContain("available");
    expect(states, "they read as blocked instead").toContain("blocked");
  }, 180_000);
});
