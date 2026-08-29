import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * Unassigning a sale returns a slot to stock without losing anything else.
 *
 * The operation is a deletion of a RELATIONSHIP, not of a row: the profile keeps
 * its number and its account, the customer keeps their record, and the history
 * gains an entry. What goes is the allocation joining them — customer, worker,
 * sale date, expiration, duration.
 *
 * `profiles_held_requires_customer` is what makes a half-done version
 * impossible: an `available` row that still names a customer is refused by the
 * database, so clearing the status without clearing the allocation cannot be
 * written at all.
 *
 * The assertions are deltas against a baseline measured moments earlier, so
 * nothing here depends on rows this file did not create.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 4 }) : null;

const PREFIX = "unassign";

let superAdmin: AppUser;
let worker: AppUser;

function email(tag: string): string {
  return `${PREFIX}-${tag}-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.invalid`;
}

async function services() {
  const { accountsService, profilesService } = await import("@/modules/accounts");
  const { dashboardService } = await import("@/modules/dashboard");
  const { quickPrepareService } = await import("@/modules/quick-prepare");
  return { accountsService, profilesService, dashboardService, quickPrepareService };
}

async function makeAccount(tag: string, slots = 5): Promise<{ id: string }> {
  const { accountsService } = await services();

  const result = await accountsService.createAccount(
    { email: email(tag), password: "not-a-real-password", country: "DZ", profileSlots: slots },
    { actor: superAdmin },
  );

  if (!result.ok) throw new Error(`could not create ${tag}: ${result.error.message}`);
  return { id: result.value.id };
}

/** Sells one profile directly, so the test controls exactly what is allocated. */
async function sellProfile(
  accountId: string,
  profileNumber: number,
): Promise<{ profileId: string; customerId: string }> {
  const digits = String(Math.floor(600_000_000 + Math.random() * 99_999_999));

  const customer = await sql!<{ id: string }[]>`
    insert into public.customers (name, phone_original, phone_normalized, whatsapp_url)
    values (${`${PREFIX}-cust`}, ${`+213${digits}`}, ${digits}, ${`https://wa.me/213${digits}`})
    returning id`;

  const updated = await sql!<{ id: string }[]>`
    update public.profiles
    set status = 'sold', customer_id = ${customer[0]!.id}::uuid, worker_id = ${superAdmin.id}::uuid,
        sale_date = current_date, expiration_date = current_date + 60, duration_days = 60
    where account_id = ${accountId}::uuid and profile_number = ${profileNumber}::smallint
    returning id`;

  return { profileId: updated[0]!.id, customerId: customer[0]!.id };
}

async function profileRow(profileId: string) {
  const rows = await sql!<
    {
      id: string;
      account_id: string;
      profile_number: number;
      status: string;
      customer_id: string | null;
      worker_id: string | null;
      sale_date: string | null;
      expiration_date: string | null;
      duration_days: number | null;
      profile_name: string | null;
      pin: string | null;
    }[]
  >`select id, account_id, profile_number, status, customer_id, worker_id,
           sale_date, expiration_date, duration_days, profile_name, pin
    from public.profiles where id = ${profileId}::uuid`;

  return rows[0];
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

  /* Same identity, Worker role — the permission is what is under test. */
  worker = { ...superAdmin, role: "worker" };
}, 120_000);

afterAll(async () => {
  if (!configured) return;

  const owned = sql!`select id from public.accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!`delete from public.profile_events where account_id in (${owned})`;
  await sql!`update public.profiles set status = 'available', customer_id = null, worker_id = null,
    sale_date = null, expiration_date = null, duration_days = null
    where customer_id in (select id from public.customers where name like ${`${PREFIX}-%`})`;
  await sql!`delete from public.customers where name like ${`${PREFIX}-%`}`;
  await sql!`delete from public.accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!.end({ timeout: 5 });
});

describe.skipIf(!configured)("unassign sale", () => {
  it("(a) a sold profile becomes available and the allocation is gone", async () => {
    const { profilesService } = await services();
    const account = await makeAccount("a-sold");
    const { profileId, customerId } = await sellProfile(account.id, 1);

    const before = await profileRow(profileId);
    expect(before?.status).toBe("sold");
    expect(before?.customer_id).toBe(customerId);

    const result = await profilesService.unassignSale(profileId, { actor: superAdmin });
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);

    const after = await profileRow(profileId);
    expect(after?.status, "available again").toBe("available");
    expect(after?.customer_id, "the allocation is removed, not just relabelled").toBeNull();
    expect(after?.worker_id).toBeNull();
    expect(after?.sale_date).toBeNull();
    expect(after?.expiration_date).toBeNull();
    expect(after?.duration_days).toBeNull();
  }, 180_000);

  it("(h) the profile, its account and the customer all survive", async () => {
    const { profilesService } = await services();
    const account = await makeAccount("h-intact");
    const { profileId, customerId } = await sellProfile(account.id, 2);

    const before = await profileRow(profileId);
    await profilesService.unassignSale(profileId, { actor: superAdmin });
    const after = await profileRow(profileId);

    expect(after?.id, "same profile row").toBe(before?.id);
    expect(after?.profile_number, "same slot number").toBe(2);
    expect(after?.account_id, "same account").toBe(account.id);
    expect(after?.profile_name, "identity untouched").toBe(before?.profile_name);
    expect(after?.pin, "PIN untouched").toBe(before?.pin);

    const customer = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.customers where id = ${customerId}::uuid`;
    expect(customer[0]!.n, "the customer is not deleted").toBe(1);

    const stillFive = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.profiles where account_id = ${account.id}::uuid`;
    expect(stillFive[0]!.n, "the account still has five profiles").toBe(5);
  }, 180_000);

  it("(h) sibling profiles are untouched", async () => {
    const { profilesService } = await services();
    const account = await makeAccount("h-siblings");
    const target = await sellProfile(account.id, 1);
    const sibling = await sellProfile(account.id, 2);

    await profilesService.unassignSale(target.profileId, { actor: superAdmin });

    const other = await profileRow(sibling.profileId);
    expect(other?.status, "the other sale is untouched").toBe("sold");
    expect(other?.customer_id).toBe(sibling.customerId);
  }, 180_000);

  it("(b) an available profile is rejected", async () => {
    const { profilesService } = await services();
    const account = await makeAccount("b-available");

    const free = await sql!<{ id: string }[]>`
      select id from public.profiles
      where account_id = ${account.id}::uuid and profile_number = 3`;

    const result = await profilesService.unassignSale(free[0]!.id, { actor: superAdmin });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFLICT");
    expect(result.error.userMessage).toMatch(/no longer sold|already been updated/i);
  }, 180_000);

  it("(c) a Worker is refused, and the sale survives", async () => {
    const { profilesService } = await services();
    const account = await makeAccount("c-worker");
    const { profileId, customerId } = await sellProfile(account.id, 1);

    const result = await profilesService.unassignSale(profileId, { actor: worker });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");

    const after = await profileRow(profileId);
    expect(after?.status, "nothing was changed").toBe("sold");
    expect(after?.customer_id).toBe(customerId);
  }, 180_000);

  it("(c) an unauthenticated caller is refused", async () => {
    const { profilesService } = await services();
    const account = await makeAccount("c-anon");
    const { profileId } = await sellProfile(account.id, 1);

    const result = await profilesService.unassignSale(profileId, { actor: null });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect((await profileRow(profileId))?.status).toBe("sold");
  }, 180_000);

  it("(d) a profile that does not exist is rejected", async () => {
    const { profilesService } = await services();

    const result = await profilesService.unassignSale("00000000-0000-4000-8000-000000000000", {
      actor: superAdmin,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  }, 180_000);

  it("(e) two simultaneous requests: exactly one succeeds", async () => {
    const { profilesService } = await services();
    const account = await makeAccount("e-race");
    const { profileId } = await sellProfile(account.id, 1);

    /* Fired together, so both are in flight before either commits. */
    const [first, second] = await Promise.all([
      profilesService.unassignSale(profileId, { actor: superAdmin }),
      profilesService.unassignSale(profileId, { actor: superAdmin }),
    ]);

    const succeeded = [first, second].filter((r) => r.ok);
    const failed = [first, second].filter((r) => !r.ok);

    expect(succeeded.length, "exactly one wins").toBe(1);
    expect(failed.length).toBe(1);

    const loser = failed[0];
    if (loser && !loser.ok) {
      expect(loser.error.code, "the loser is told the state moved").toBe("CONFLICT");
    }

    expect((await profileRow(profileId))?.status).toBe("available");
  }, 180_000);

  it("(e) a retry after success is refused rather than repeated", async () => {
    const { profilesService } = await services();
    const account = await makeAccount("e-retry");
    const { profileId } = await sellProfile(account.id, 1);

    const first = await profilesService.unassignSale(profileId, { actor: superAdmin });
    const retry = await profilesService.unassignSale(profileId, { actor: superAdmin });

    expect(first.ok).toBe(true);
    expect(retry.ok, "the second call does nothing").toBe(false);

    /* (g) One event, not two — a retry cannot duplicate the history. */
    const events = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.profile_events
      where profile_id = ${profileId}::uuid and metadata->>'outcome' = 'sale_unassigned'`;
    expect(events[0]!.n, "exactly one unassign event").toBe(1);
  }, 180_000);

  it("(g) the history records what was removed", async () => {
    const { profilesService } = await services();
    const account = await makeAccount("g-audit");
    const { profileId, customerId } = await sellProfile(account.id, 4);

    await profilesService.unassignSale(profileId, { actor: superAdmin });

    const events = await sql!<
      {
        event_type: string;
        user_id: string | null;
        customer_id: string | null;
        metadata: Record<string, unknown>;
        created_at: Date;
      }[]
    >`select event_type, user_id, customer_id, metadata, created_at
      from public.profile_events
      where profile_id = ${profileId}::uuid and metadata->>'outcome' = 'sale_unassigned'`;

    expect(events.length, "one event was written").toBe(1);

    const event = events[0]!;
    expect(event.user_id, "who did it").toBe(superAdmin.id);
    expect(event.customer_id, "whose sale it was").toBe(customerId);
    expect(event.created_at, "when").toBeInstanceOf(Date);
    expect(event.metadata["previousStatus"], "what it was").toBe("sold");
    expect(event.metadata["profileNumber"]).toBe(4);
    expect(event.metadata["previousCustomerId"]).toBe(customerId);
    expect(event.metadata["previousDurationDays"], "the allocation that ended").toBe(60);

    /* The account timeline is built from these rows, so it gains the entry too. */
    const onAccount = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.profile_events
      where account_id = ${account.id}::uuid and metadata->>'outcome' = 'sale_unassigned'`;
    expect(onAccount[0]!.n).toBe(1);
  }, 180_000);

  it("(f) dashboard and Quick Prepare see the profile again", async () => {
    const { profilesService, dashboardService, quickPrepareService } = await services();
    const account = await makeAccount("f-stock", 5);
    const { profileId } = await sellProfile(account.id, 1);

    const before = await dashboardService.load(superAdmin);
    if (!before.ok) throw new Error("dashboard failed");
    const availableBefore = before.value.counts.profiles.available;
    const soldBefore = before.value.counts.profiles.sold;

    const stockResult = await quickPrepareService.availableStock();
    if (!stockResult.ok) throw new Error("stock read failed");
    const stockBefore = stockResult.value;

    await profilesService.unassignSale(profileId, { actor: superAdmin });

    const after = await dashboardService.load(superAdmin);
    if (!after.ok) throw new Error("dashboard failed");

    expect(after.value.counts.profiles.available, "back in stock").toBe(availableBefore + 1);
    expect(after.value.counts.profiles.sold, "and out of sold").toBe(soldBefore - 1);

    /*
     * And the allocator agrees, asked the way it actually answers.
     *
     * `preview` returns the accounts it would USE, ranked — a freshly freed slot
     * on an untouched account ranks below partially-sold ones because of the
     * anti-fragmentation preference, so its absence from a plan says nothing
     * about eligibility. `availableStock` is the eligible pool itself, which is
     * the question this test is asking.
     */
    const stockAfter = await quickPrepareService.availableStock();
    expect(stockAfter.ok).toBe(true);
    if (!stockAfter.ok) return;

    expect(stockAfter.value, "the allocator counts the freed slot").toBe(stockBefore + 1);

    /* And it is genuinely reachable: a request for one profile succeeds. */
    const preview = await quickPrepareService.preview({ profileCount: 1, durationDays: 30 });
    expect(preview.ok, preview.ok ? "" : preview.error.message).toBe(true);
  }, 180_000);

  it("(f) the accounts list tally reflects the release", async () => {
    const { accountsService, profilesService } = await services();
    const account = await makeAccount("f-list", 5);
    const { profileId } = await sellProfile(account.id, 1);

    const rowFor = async () => {
      const page = await accountsService.listAccounts({ limit: 200 });
      if (!page.ok) throw new Error("list failed");
      return page.value.items.find((row) => row.account.id === account.id);
    };

    const before = await rowFor();
    expect(before?.soldProfiles).toBe(1);

    await profilesService.unassignSale(profileId, { actor: superAdmin });

    const after = await rowFor();
    expect(after?.soldProfiles, "one fewer sold").toBe((before?.soldProfiles ?? 0) - 1);
    expect(after?.availableProfiles, "one more available").toBe(
      (before?.availableProfiles ?? 0) + 1,
    );
  }, 180_000);
});
