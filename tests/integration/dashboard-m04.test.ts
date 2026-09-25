import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M04 — the dashboard against a real database, reconciled with the screens it
 * summarises: the Accounts list, Quick Prepare, the Problems list.
 *
 * This file's database is its own (per-file isolated DB), seeded with users and
 * one customer but no accounts, so every figure below is exact rather than a
 * delta. LOCAL ONLY.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;

const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

let superAdmin: AppUser;
let counter = 0;

async function services() {
  const { dashboardService } = await import("@/modules/dashboard");
  const { accountsService } = await import("@/modules/accounts");
  const { problemsService, problemResolutionService } = await import("@/modules/problems");
  const { quickPrepareService } = await import("@/modules/quick-prepare");
  return {
    dashboardService,
    accountsService,
    problemsService,
    problemResolutionService,
    quickPrepareService,
  };
}

async function makeAccount(label: string) {
  const { accountsService } = await services();
  counter += 1;
  const created = await accountsService.createAccount(
    {
      email: `m04-${label}-${counter}@example.invalid`,
      password: "not-a-real-password",
      country: "DZ",
      profileSlots: 5,
    },
    { actor: superAdmin },
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value.id;
}

async function report(accountId: string, issueType = "payment_problem") {
  const { problemsService } = await services();
  const created = await problemsService.report({ accountId, issueType }, { actor: superAdmin });
  if (!created.ok) throw new Error(created.error.message);
  return created.value.id;
}

async function sell(accountId: string, profileNumber: number, days: number, soldDaysAgo = 0) {
  counter += 1;
  const digits = String(670_000_000 + counter);
  const [customer] = await sql!<{ id: string }[]>`
    insert into customers (name, phone_original, phone_normalized, whatsapp_url)
    values (${`m04 ${counter}`}, ${`0${digits}`}, ${digits}, ${`https://wa.me/213${digits}`})
    returning id`;
  /* Dates from the UTC calendar, the application's convention. */
  await sql!`
    update profiles
    set status = 'sold', customer_id = ${customer!.id}::uuid,
        sale_date = (now() at time zone 'UTC')::date - ${soldDaysAgo}::int,
        duration_days = ${days}::int,
        expiration_date = (now() at time zone 'UTC')::date - ${soldDaysAgo}::int + ${days}::int
    where account_id = ${accountId}::uuid and profile_number = ${profileNumber}`;
}

async function dashboard() {
  const { dashboardService } = await services();
  const result = await dashboardService.load(superAdmin);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function stockTotal(): Promise<number> {
  const { dashboardService } = await services();
  const result = await dashboardService.stock(superAdmin);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.totalAllocatable;
}

async function quickPrepareStock(): Promise<number> {
  const { quickPrepareService } = await services();
  const result = await quickPrepareService.availableStock();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  if (!local) return;

  const [admin] = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from users where role = 'super_admin' and status = 'active' limit 1`;
  superAdmin = {
    id: admin!.id,
    email: admin!.email,
    displayName: admin!.name,
    initials: "SA",
    role: "super_admin",
  };

  /*
   * The fixture: one account per state, and a profile of each kind.
   *
   *   healthy   5 profiles: 1 sold (60d), 1 expiring (2d), 1 expired (-5d), 2 free
   *   blocked   5 free, one open payment problem
   *   triple    5 free, three open problems (payment ×2, invalid email)
   *   expired   5 free, own valid_until in the past
   *   archived  5 free, archived
   *   fault     5 free, stored status incorrect_password, no problem
   *   gone      5 free, soft-deleted, carrying an open problem
   */
  ids["healthy"] = await makeAccount("healthy");
  await sell(ids["healthy"], 1, 60);
  await sell(ids["healthy"], 2, 30, 28);
  await sell(ids["healthy"], 3, 30, 35);

  ids["blocked"] = await makeAccount("blocked");
  await report(ids["blocked"], "payment_problem");

  ids["triple"] = await makeAccount("triple");
  await report(ids["triple"], "payment_problem");
  await report(ids["triple"], "payment_problem");
  await report(ids["triple"], "invalid_email");

  ids["expired"] = await makeAccount("expired");
  await sql!`update accounts set valid_until = (now() at time zone 'UTC')::date - 2
             where id = ${ids["expired"]}::uuid`;

  ids["archived"] = await makeAccount("archived");
  await sql!`update accounts set status = 'archived' where id = ${ids["archived"]}::uuid`;

  ids["fault"] = await makeAccount("fault");
  await sql!`update accounts set status = 'incorrect_password' where id = ${ids["fault"]}::uuid`;

  ids["gone"] = await makeAccount("gone");
  await report(ids["gone"], "invalid_email");
  await sql!`update accounts set status = 'deleted', deleted_at = now() where id = ${ids["gone"]}::uuid`;
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe.skipIf(!local)("account KPIs", () => {
  it("1–6, 18. four disjoint buckets from the effective state, summing to Total", async () => {
    const { accounts } = (await dashboard()).counts;

    expect(accounts).toEqual({ total: 6, healthy: 1, problems: 3, expired: 1, archived: 1 });
    expect(accounts.healthy + accounts.problems + accounts.expired + accounts.archived).toBe(
      accounts.total,
    );
  });

  it("18. Healthy equals the Accounts list's Healthy filter", async () => {
    const { accountsService } = await services();
    const filter = await accountsService.listAccounts({ status: "healthy", limit: 100 });

    expect(filter.ok && filter.value.total).toBe((await dashboard()).counts.accounts.healthy);
  });
});

describe.skipIf(!local)("profile KPIs", () => {
  it("7–12. every live profile counted once, from the derived state", async () => {
    const { profiles } = (await dashboard()).counts;

    expect(profiles).toEqual({
      total: 30,
      available: 2,
      sold: 1,
      expiringSoon: 1,
      expired: 1,
      /* blocked (5) + triple (5) + expired account (5) + archived (5) + fault (5) */
      blocked: 25,
      notForSale: 0,
      resellableExpired: 1,
    });
    expect(
      profiles.available +
        profiles.sold +
        profiles.expiringSoon +
        profiles.expired +
        profiles.blocked +
        profiles.notForSale,
    ).toBe(profiles.total);
  });

  it("13. expirations are disjoint and reconcile with the profile figures", async () => {
    const { profiles, expirations } = (await dashboard()).counts;

    expect(expirations).toEqual({
      expired: 1,
      today: 0,
      tomorrow: 0,
      inTwoToThree: 1,
      inFourToSeven: 0,
    });
    expect(expirations.today + expirations.tomorrow + expirations.inTwoToThree).toBe(
      profiles.expiringSoon,
    );
    expect(expirations.expired).toBe(profiles.expired);
  });
});

describe.skipIf(!local)("problem KPIs", () => {
  it("13–15. records vs affected accounts, payment problems, live accounts only", async () => {
    const { problems } = (await dashboard()).counts;

    expect(problems).toMatchObject({
      open: 4,
      blocking: 4,
      /* one problem on 'blocked', three on 'triple'; the deleted account's is excluded */
      accountsAffected: 2,
      paymentProblems: 3,
      paymentProblemAccounts: 2,
    });
  });

  it("19. the charts add up to the KPI they break down", async () => {
    const data = await dashboard();
    const sum = (items: readonly { count: number }[] | null) =>
      (items ?? []).reduce((total, item) => total + item.count, 0);

    expect(sum(data.charts.problemsByType)).toBe(data.counts.problems.blocking);
    expect(sum(data.charts.problemsBySeverity)).toBe(data.counts.problems.blocking);
    expect(data.charts.problemsByType).toEqual([
      { label: "payment_problem", count: 3 },
      { label: "invalid_email", count: 1 },
    ]);
  });
});

describe.skipIf(!local)("stock", () => {
  it("16. the dashboard's stock is Quick Prepare's stock", async () => {
    expect(await stockTotal()).toBe(await quickPrepareStock());
  });

  it("16. and reconciles with the profile figures: Available + resellable expired", async () => {
    const { profiles } = (await dashboard()).counts;

    /* healthy account: 2 free + 1 expired allocation that may be resold */
    expect(await stockTotal()).toBe(profiles.available + profiles.resellableExpired);
    expect(await stockTotal()).toBe(3);
  });

  it("the per-account breakdown sees real stock (it saw none before M04)", async () => {
    const { dashboardService } = await services();
    const stock = await dashboardService.stock(superAdmin);

    expect(stock.ok && stock.value.top).toEqual([
      expect.objectContaining({ accountId: ids["healthy"], allocatable: 3, total: 5 }),
    ]);
  });

  it("17, 26. a blocked account with 5 free profiles adds nothing to stock", async () => {
    const before = await stockTotal();
    const id = await makeAccount("blocked-free");
    await report(id, "incorrect_password");

    expect(await stockTotal()).toBe(before);
    expect((await dashboard()).counts.profiles.available).toBe(2);
  });
});

describe.skipIf(!local)("the dashboard follows mutations", () => {
  it("23. resolving the last blocking problem moves the account from Problems to Healthy", async () => {
    const { problemResolutionService } = await services();
    const id = await makeAccount("to-resolve");
    const problem = await report(id);
    const before = (await dashboard()).counts;

    await problemResolutionService.resolve(
      problem,
      { resolutionNote: "Payment went through on retry." },
      { actor: superAdmin },
    );
    const after = (await dashboard()).counts;

    expect(after.accounts.healthy - before.accounts.healthy).toBe(1);
    expect(after.accounts.problems - before.accounts.problems).toBe(-1);
    expect(after.profiles.available - before.profiles.available).toBe(5);
    expect(after.profiles.blocked - before.profiles.blocked).toBe(-5);
  });

  it("24. selling a profile moves it from Available to Sold", async () => {
    const id = await makeAccount("to-sell");
    const before = (await dashboard()).counts.profiles;

    await sell(id, 1, 90);
    const after = (await dashboard()).counts.profiles;

    expect(after.sold - before.sold).toBe(1);
    expect(after.available - before.available).toBe(-1);
  });
});

describe.skipIf(!local)("dates are UTC in SQL too", () => {
  it("20–22. sales today / yesterday / this month do not move with the session time zone", async () => {
    const [profile] = await sql!<{ id: string; account_id: string }[]>`
      select id, account_id from profiles where account_id = ${ids["healthy"] ?? ""}::uuid limit 1`;

    const insertAt = async (at: string): Promise<void> => {
      await sql!.unsafe(
        `insert into profile_events (account_id, profile_id, event_type, created_at)
         values ($1, $2, 'sold', ${at})`,
        [profile!.account_id, profile!.id],
      );
    };

    const before = (await dashboard()).counts.prepared;

    /* One second either side of UTC midnight, and just before the UTC month began. */
    await insertAt("date_trunc('day', now(), 'UTC') + interval '1 second'");
    await insertAt("date_trunc('day', now(), 'UTC') - interval '1 second'");
    await insertAt("date_trunc('month', now(), 'UTC') - interval '1 second'");

    const utc = (await dashboard()).counts.prepared;

    expect(utc.today - before.today).toBe(1);
    expect(utc.yesterday - before.yesterday).toBe(1);
    /* Only the "today" event is certainly inside this month; yesterday may be last month. */
    expect(utc.thisMonth - before.thisMonth).toBeGreaterThanOrEqual(1);
    expect(utc.thisMonth - before.thisMonth).toBeLessThanOrEqual(2);

    /*
     * The same question from a session fourteen hours ahead of UTC. The
     * in-process database has one session, shared with the application's pool,
     * so this changes what `current_date` means to every query that relies on
     * it — and must change nothing on the dashboard.
     */
    await sql!`set time zone 'Pacific/Kiritimati'`;
    try {
      const shifted = (await dashboard()).counts.prepared;
      expect(shifted).toEqual(utc);
    } finally {
      await sql!`set time zone 'UTC'`;
    }
  });
});
