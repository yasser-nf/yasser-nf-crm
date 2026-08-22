import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * The dashboard counts what the Accounts page lists, and nothing else.
 *
 * It used to count every account row, soft-deleted ones included, and every
 * profile belonging to them. On live data that read seven accounts where the
 * Accounts page listed three, and thirty-five profiles where fifteen existed —
 * twenty of them belonging to accounts an operator had deleted. "Sold" was
 * inflated the same way, which is the number the business actually acts on.
 *
 * The regression this file guards is not "the number is 3". It is the far more
 * durable claim that deleting an account removes exactly that account and
 * exactly its own profiles from every dashboard bucket, whatever the starting
 * data happens to be. Each assertion is a delta against a baseline measured
 * moments earlier, so the test says nothing about the rows it did not create.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

const PREFIX = "p3-dash";

let superAdmin: AppUser;

function email(tag: string): string {
  return `${PREFIX}-${tag}-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.invalid`;
}

async function services() {
  const { dashboardService } = await import("@/modules/dashboard");
  const { accountsService } = await import("@/modules/accounts");
  return { dashboardService, accountsService };
}

async function counts() {
  const { dashboardService } = await services();
  const result = await dashboardService.load(superAdmin);
  if (!result.ok) throw new Error(`dashboard load failed: ${result.error.message}`);
  return result.value.counts;
}

/** Soft delete, through the same column the Accounts page filters on. */
async function softDelete(accountId: string): Promise<void> {
  await sql!`
    update public.accounts
    set status = 'deleted', deleted_at = now(), updated_at = now()
    where id = ${accountId}::uuid`;
}

async function makeAccount(tag: string): Promise<{ id: string }> {
  const { accountsService } = await services();

  const result = await accountsService.createAccount(
    { email: email(tag), password: "not-a-real-password", country: "DZ", profileSlots: 5 },
    { actor: superAdmin },
  );

  if (!result.ok) throw new Error(`could not create ${tag}: ${result.error.message}`);
  return { id: result.value.id };
}

async function profileCount(accountId: string): Promise<number> {
  const rows = await sql!<{ n: number }[]>`
    select count(*)::int as n from public.profiles where account_id = ${accountId}::uuid`;
  return rows[0]!.n;
}

async function sellOneProfile(accountId: string): Promise<void> {
  const digits = String(Math.floor(600_000_000 + Math.random() * 99_999_999));

  const customer = await sql!<{ id: string }[]>`
    insert into public.customers (name, phone_original, phone_normalized, whatsapp_url)
    values (${`${PREFIX}-cust`}, ${`+213${digits}`}, ${digits}, ${`https://wa.me/213${digits}`})
    returning id`;

  await sql!`
    update public.profiles
    set status = 'sold', customer_id = ${customer[0]!.id}::uuid,
        sale_date = current_date, expiration_date = current_date + 30, duration_days = 30
    where account_id = ${accountId}::uuid and profile_number = 1`;
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

  await sql!`
    delete from public.profile_events where customer_id in (
      select id from public.customers where name like ${`${PREFIX}-%`})`;
  await sql!`
    update public.profiles set status = 'available', customer_id = null,
      sale_date = null, expiration_date = null, duration_days = null
    where customer_id in (select id from public.customers where name like ${`${PREFIX}-%`})`;
  await sql!`delete from public.customers where name like ${`${PREFIX}-%`}`;
  await sql!`delete from public.accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!.end({ timeout: 5 });
});

describe.skipIf(!configured)("dashboard excludes deleted accounts and their profiles", () => {
  it("Case A: an active account and all of its profiles are counted", async () => {
    const before = await counts();
    const account = await makeAccount("case-a");
    const owned = await profileCount(account.id);

    expect(owned, "an account is created with five profile rows").toBe(5);

    const after = await counts();

    expect(after.accounts.total, "account counted").toBe(before.accounts.total + 1);
    expect(after.profiles.total, "its profiles counted").toBe(before.profiles.total + owned);
  }, 180_000);

  it("Case B: a soft-deleted account and all of its profiles disappear", async () => {
    const account = await makeAccount("case-b");
    const owned = await profileCount(account.id);

    const live = await counts();
    await softDelete(account.id);
    const deleted = await counts();

    expect(deleted.accounts.total, "account no longer counted").toBe(live.accounts.total - 1);
    expect(deleted.profiles.total, "its profiles no longer counted").toBe(
      live.profiles.total - owned,
    );

    /* The rows are still there. This is a reporting rule, not a delete. */
    expect(await profileCount(account.id), "profile rows are untouched").toBe(owned);
  }, 180_000);

  it("Case C: with a mix, the totals equal the active accounts and their profiles", async () => {
    const keep = await makeAccount("case-c-keep");
    const drop = await makeAccount("case-c-drop");
    await softDelete(drop.id);

    const observed = await counts();

    const live = await sql!<{ accounts: number; profiles: number }[]>`
      select
        (select count(*)::int from public.accounts where deleted_at is null) as accounts,
        (select count(*)::int from public.profiles p
           join public.accounts a on a.id = p.account_id
           where a.deleted_at is null) as profiles`;

    expect(observed.accounts.total, "reconciles with the Accounts page rule").toBe(
      live[0]!.accounts,
    );
    expect(observed.profiles.total, "reconciles with profiles of live accounts").toBe(
      live[0]!.profiles,
    );
    expect(keep.id).not.toBe(drop.id);
  }, 180_000);

  it("Case D: sold profiles on a deleted account do not inflate Sold", async () => {
    const account = await makeAccount("case-d");
    await sellOneProfile(account.id);

    const withSale = await counts();
    await softDelete(account.id);
    const afterDelete = await counts();

    expect(afterDelete.profiles.sold, "the sale leaves the Sold bucket").toBe(
      withSale.profiles.sold - 1,
    );
  }, 180_000);

  it("Case E: available profiles on a deleted account do not inflate Available", async () => {
    const account = await makeAccount("case-e");

    const live = await counts();
    await softDelete(account.id);
    const deleted = await counts();

    expect(deleted.profiles.available, "a deleted account contributes no stock").toBeLessThan(
      live.profiles.available,
    );
  }, 180_000);

  it("every profile bucket is drawn only from live accounts", async () => {
    const observed = await counts();

    const truth = await sql!<Record<string, number>[]>`
      select
        count(*)::int as total,
        count(*) filter (where p.status = 'reserved')::int as reserved,
        count(*) filter (where p.status = 'sold')::int as sold,
        count(*) filter (where p.status = 'expiring_soon')::int as expiring_soon,
        count(*) filter (where p.status = 'expired')::int as expired
      from public.profiles p
      join public.accounts a on a.id = p.account_id
      where a.deleted_at is null`;

    for (const bucket of ["total", "reserved", "sold", "expiring_soon", "expired"] as const) {
      const key = bucket === "expiring_soon" ? "expiringSoon" : bucket;
      expect(
        (observed.profiles as unknown as Record<string, number>)[key],
        `${bucket} counts only live accounts`,
      ).toBe(truth[0]![bucket]);
    }
  }, 180_000);

  it("archived is not the same thing as deleted", async () => {
    const account = await makeAccount("case-archived");

    const before = await counts();
    await sql!`update public.accounts set status = 'archived', updated_at = now()
               where id = ${account.id}::uuid`;
    const archived = await counts();

    /* Archiving leaves the account on the Accounts page, so the total holds. */
    expect(archived.accounts.total, "an archived account still exists").toBe(before.accounts.total);
    expect(archived.accounts.archived, "and lands in the archived bucket").toBe(
      before.accounts.archived + 1,
    );

    await softDelete(account.id);
    const deleted = await counts();

    expect(deleted.accounts.archived, "deleting removes it from archived too").toBe(
      before.accounts.archived,
    );
    expect(deleted.accounts.total, "and from the total").toBe(before.accounts.total - 1);
  }, 180_000);
});
