import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * Profile editing, end to end.
 *
 * M13 §5 opened the allocation fields — customer, sale date, expiration,
 * duration — to a manual editor. That is the moment the editor could become a
 * back door around Quick Prepare: an operator typing an expiration date can
 * create an allocation the allocation engine would have refused.
 *
 * These tests exist to prove it cannot. The important ones are the refusals.
 *
 * All fixtures live on the reserved `.invalid` domain with their own customers,
 * and the real customer allocation in this database is never touched.
 *
 * TIMEOUTS: 150s per test, not the 30s default.
 *
 * Each test creates a real account — one insert, five profiles, five events and
 * an audit entry — then performs locked updates on top. That is roughly fifteen
 * round trips to a remote Supabase pooler, which costs 20-40s on its own and
 * more when the rest of the suite is competing for the same fifteen connections.
 * A 90s budget passed in isolation and timed out inside the full suite, which is
 * a statement about latency rather than about the code under test.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

const PREFIX = "m13-edit";
const PLAINTEXT = "not-a-real-password";

let superAdmin: AppUser;

function email(name: string): string {
  return `${PREFIX}-${name}-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.invalid`;
}

async function services() {
  const { accountsService, profilesService } = await import("@/modules/accounts");
  return { accountsService, profilesService };
}

/** An account plus its five profile rows. */
async function makeAccount(tag: string, options: { profileSlots?: number; durationDays?: number }) {
  const { accountsService } = await services();

  const created = await accountsService.createAccount(
    {
      email: email(tag),
      password: PLAINTEXT,
      country: "DZ",
      ...(options.profileSlots === undefined ? {} : { profileSlots: options.profileSlots }),
      ...(options.durationDays === undefined ? {} : { durationDays: options.durationDays }),
    },
    { actor: superAdmin },
  );

  if (!created.ok) throw new Error(`setup failed: ${created.error.message}`);

  const rows = await sql!<{ id: string; profile_number: number }[]>`
    select id, profile_number from public.profiles
    where account_id = ${created.value.id}::uuid order by profile_number
  `;

  return { account: created.value, profileIds: rows.map((row) => row.id) };
}

/** A throwaway customer, so no real allocation is involved. */
async function makeCustomer(tag: string): Promise<string> {
  const digits = String(Math.floor(600_000_000 + Math.random() * 99_999_999));

  const rows = await sql!<{ id: string }[]>`
    insert into public.customers (name, phone_original, phone_normalized, whatsapp_url)
    values (${`${PREFIX}-${tag}`}, ${`+213${digits}`}, ${digits}, ${`https://wa.me/213${digits}`})
    returning id
  `;

  return rows[0]!.id;
}

async function sellTo(profileId: string, customerId: string, expiresInDays: number) {
  await sql!`
    update public.profiles
    set status = 'sold', customer_id = ${customerId}::uuid,
        sale_date = current_date, expiration_date = current_date + ${expiresInDays}::int,
        duration_days = ${expiresInDays}::int
    where id = ${profileId}::uuid
  `;
}

beforeAll(async () => {
  if (!configured) return;

  const admins = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users
    where role = 'super_admin' and status = 'active' and deleted_at is null limit 1
  `;

  const admin = admins[0];
  if (!admin) throw new Error("No active Super Admin to authorize as");

  superAdmin = {
    id: admin.id,
    email: admin.email,
    displayName: admin.name,
    initials: "SA",
    role: "super_admin",
  };
});

/**
 * The phone numbers these tests hand to `customerPhone`.
 *
 * They matter for cleanup: `findOrCreateByPhone` creates a customer with a NULL
 * name, so the `name like 'm13-%'` filter below never matched them and eight
 * customers survived a run. Deleting by the exact numbers this file uses is
 * unambiguous — it cannot reach a real customer, because a real one would have
 * been matched and reused rather than created.
 */
const TEST_PHONES = [
  "663947116",
  "663947117",
  "663947118",
  "663947119",
  "663947120",
  "663947121",
  "663947122",
  "663947123",
];

afterAll(async () => {
  if (!configured) return;

  await sql!`delete from public.accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!`delete from public.customers where name like ${`${PREFIX}-%`}`;

  /*
   * Only customers this file created AND that hold nothing on a real account.
   * The second condition is the safety net: if one of these numbers ever
   * belongs to a genuine customer, it is left alone.
   */
  await sql!`
    delete from public.customers c
    where c.phone_normalized = any(${TEST_PHONES})
      and not exists (
        select 1 from public.profiles p
        join public.accounts a on a.id = p.account_id
        where p.customer_id = c.id and a.email not like '%@example.invalid'
      )
  `;

  await sql!.end({ timeout: 5 });
});

describe.skipIf(!configured)("identity fields", () => {
  it("edits name, PIN and notes on an available profile", async () => {
    const { profilesService } = await services();
    const { profileIds } = await makeAccount("identity", {});

    const result = await profilesService.updateProfile(
      profileIds[0]!,
      { profileName: "Living room", pin: "4321", notes: "TV in the lounge" },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.profile.profileName).toBe("Living room");
    expect(result.value.profile.pin).toBe("4321");
    expect(result.value.profile.notes).toBe("TV in the lounge");
  }, 150_000);

  it("leaves untouched fields alone", async () => {
    /* Blank means unchanged: editing a PIN must not wipe a name. */
    const { profilesService } = await services();
    const { profileIds } = await makeAccount("partial", {});

    await profilesService.updateProfile(
      profileIds[0]!,
      { profileName: "Kept", pin: "1111" },
      { actor: superAdmin },
    );

    const second = await profilesService.updateProfile(
      profileIds[0]!,
      { pin: "2222" },
      { actor: superAdmin },
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.profile.profileName).toBe("Kept");
    expect(second.value.profile.pin).toBe("2222");
  }, 150_000);

  it("rejects a PIN that is not four digits", async () => {
    const { profilesService } = await services();
    const { profileIds } = await makeAccount("badpin", {});

    for (const pin of ["12", "abcd", "123456"]) {
      const result = await profilesService.updateProfile(
        profileIds[0]!,
        { pin },
        { actor: superAdmin },
      );

      expect(result.ok, `pin=${pin} accepted`).toBe(false);
    }
  }, 150_000);
});

describe.skipIf(!configured)("allocation rules — the refusals", () => {
  it("refuses an expiration beyond the account's own validity", async () => {
    /*
     * THE rule. The account is valid for 30 days; the edit asks for 200. Quick
     * Prepare would refuse this, so the editor must too.
     */
    const { profilesService } = await services();
    const { profileIds } = await makeAccount("beyond", { durationDays: 30 });
    const customer = await makeCustomer("beyond");

    const result = await profilesService.updateProfile(
      profileIds[0]!,
      {
        customerPhone: "0663947116",
        saleDate: new Date().toISOString().slice(0, 10),
        expirationDate: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10),
        durationDays: 200,
      },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const fieldErrors = "fieldErrors" in result.error ? (result.error.fieldErrors ?? {}) : {};
    expect(fieldErrors).toHaveProperty("expirationDate");
    expect(customer).toBeTruthy();
  }, 150_000);

  it("accepts an expiration inside the account's validity", async () => {
    const { profilesService } = await services();
    const { profileIds } = await makeAccount("inside", { durationDays: 200 });

    const result = await profilesService.updateProfile(
      profileIds[0]!,
      {
        customerPhone: "0663947117",
        saleDate: new Date().toISOString().slice(0, 10),
        expirationDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
        durationDays: 30,
      },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.profile.customerId).not.toBeNull();
    expect(result.value.profile.durationDays).toBe(30);
  }, 150_000);

  it("lets an open-ended account carry any expiration", async () => {
    const { profilesService } = await services();
    const { profileIds } = await makeAccount("openended", {});

    const result = await profilesService.updateProfile(
      profileIds[0]!,
      {
        customerPhone: "0663947118",
        expirationDate: new Date(Date.now() + 700 * 86_400_000).toISOString().slice(0, 10),
        durationDays: 700,
      },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
  }, 150_000);

  it("refuses an expiration before the sale date", async () => {
    const { profilesService } = await services();
    const { profileIds } = await makeAccount("reversed", {});

    const result = await profilesService.updateProfile(
      profileIds[0]!,
      {
        customerPhone: "0663947119",
        saleDate: "2026-12-01",
        expirationDate: "2026-01-01",
      },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const fieldErrors = "fieldErrors" in result.error ? (result.error.fieldErrors ?? {}) : {};
    expect(fieldErrors).toHaveProperty("expirationDate");
  }, 150_000);

  it("refuses a non-positive duration and an impossible date", async () => {
    const { profilesService } = await services();
    const { profileIds } = await makeAccount("badvalues", {});

    for (const patch of [
      { durationDays: 0 },
      { durationDays: -30 },
      { durationDays: 900 },
      { expirationDate: "2026-02-30" },
      { saleDate: "not-a-date" },
    ]) {
      const result = await profilesService.updateProfile(profileIds[0]!, patch, {
        actor: superAdmin,
      });

      expect(result.ok, `${JSON.stringify(patch)} accepted`).toBe(false);
    }
  }, 150_000);
});

describe.skipIf(!configured)("not-for-sale slots stay not for sale", () => {
  it("allows identity edits but refuses an allocation", async () => {
    const { profilesService } = await services();
    /* Two sellable slots, so profile 5 is permanently out of stock. */
    const { profileIds } = await makeAccount("parked", { profileSlots: 2 });
    const parked = profileIds[4]!;

    const identity = await profilesService.updateProfile(
      parked,
      { profileName: "Spare", pin: "9999" },
      { actor: superAdmin },
    );

    expect(identity.ok, identity.ok ? "" : identity.error.message).toBe(true);

    const allocation = await profilesService.updateProfile(
      parked,
      { customerPhone: "0663947120", durationDays: 30 },
      { actor: superAdmin },
    );

    expect(allocation.ok).toBe(false);
  }, 150_000);

  it("leaves the slot unallocatable afterwards", async () => {
    const { accountsService, profilesService } = await services();
    const { account, profileIds } = await makeAccount("stillparked", { profileSlots: 2 });

    await profilesService.updateProfile(
      profileIds[4]!,
      { profileName: "Still spare" },
      { actor: superAdmin },
    );

    const detail = await accountsService.getAccountDetail(account.id);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;

    const fifth = detail.value.indicators.find((i) => i.profileNumber === 5);
    expect(fifth?.state).toBe("not_for_sale");
  }, 150_000);
});

describe.skipIf(!configured)("sold profiles", () => {
  it("refuses to clear the customer instead of silently releasing", async () => {
    /*
     * A release is Quick Replace's job, where it is transactional and audited as
     * one operation. Blanking the column here would strand the customer.
     */
    const { profilesService } = await services();
    const { profileIds } = await makeAccount("held", {});
    const customer = await makeCustomer("held");

    await sellTo(profileIds[0]!, customer, 30);

    /* An empty phone is rejected by the schema before it can clear anything. */
    const result = await profilesService.updateProfile(
      profileIds[0]!,
      { customerPhone: "" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);

    const after = await sql!<{ customer_id: string | null; status: string }[]>`
      select customer_id, status from public.profiles where id = ${profileIds[0]!}::uuid
    `;

    expect(after[0]!.customer_id).toBe(customer);
    expect(after[0]!.status).toBe("sold");
  }, 150_000);

  it("does not write an expired status when editing a lapsed allocation", async () => {
    /*
     * ADR-013 D2: expiry is derived from the date. An editor that stored
     * `expired` would create the second source of truth M13 removed.
     */
    const { profilesService } = await services();
    const { profileIds } = await makeAccount("lapsed", {});
    const customer = await makeCustomer("lapsed");

    /*
     * Sold 60 days ago, lapsed 5 days ago. The sale date moves back with the
     * expiry — profiles_expiry_after_sale forbids an expiry before the sale,
     * and an allocation that expired before it started is not a real fixture.
     */
    await sellTo(profileIds[0]!, customer, 30);
    await sql!`
      update public.profiles
      set sale_date = current_date - 60, expiration_date = current_date - 5, duration_days = 55
      where id = ${profileIds[0]!}::uuid
    `;

    const result = await profilesService.updateProfile(
      profileIds[0]!,
      { profileName: "Renamed after expiry" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /* Still `sold` in the column; the date is what makes it expired. */
    expect(result.value.profile.status).toBe("sold");
  }, 150_000);
});

describe.skipIf(!configured)("audit and history", () => {
  it("writes a profile event and an audit entry for each field that moved", async () => {
    const { profilesService } = await services();
    const { account, profileIds } = await makeAccount("history", { durationDays: 365 });

    const result = await profilesService.updateProfile(
      profileIds[0]!,
      {
        profileName: "Audited",
        pin: "8888",
        customerPhone: "0663947121",
        durationDays: 60,
        expirationDate: new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10),
      },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    const types = result.value.events.map((event) => event.eventType).sort();
    expect(types).toContain("name_changed");
    expect(types).toContain("pin_changed");
    expect(types).toContain("customer_changed");
    expect(types).toContain("extended");

    const audits = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.audit_logs
      where entity = 'profile' and entity_id = ${profileIds[0]!}::uuid and action = 'update'
    `;
    expect(audits[0]!.n).toBeGreaterThan(0);

    /* The PIN moved but must not appear in the append-only history. */
    const events = await sql!<{ metadata: unknown }[]>`
      select metadata from public.profile_events
      where profile_id = ${profileIds[0]!}::uuid and event_type = 'pin_changed'
    `;
    expect(JSON.stringify(events)).not.toContain("8888");
    expect(account.id).toBeTruthy();
  }, 120_000);

  it("keeps the account credential out of the audit payload", async () => {
    const { profilesService } = await services();
    const { account, profileIds } = await makeAccount("nocred", {});

    await profilesService.updateProfile(
      profileIds[0]!,
      { profileName: "No credential" },
      { actor: superAdmin },
    );

    const stored = await sql!<{ password_encrypted: string }[]>`
      select password_encrypted from public.accounts where id = ${account.id}::uuid
    `;

    const audits = await sql!<{ before: unknown; after: unknown }[]>`
      select before, after from public.audit_logs
      where entity = 'profile' and entity_id = ${profileIds[0]!}::uuid
    `;

    const serialised = JSON.stringify(audits);
    expect(serialised).not.toContain(PLAINTEXT);
    expect(serialised).not.toContain(stored[0]!.password_encrypted);
  }, 150_000);
});

describe.skipIf(!configured)("the profile editor cannot reach the account", () => {
  it("leaves the account password byte-identical", async () => {
    /*
     * Requirement 10 of the Item 4 review, pinned rather than argued. The
     * editor writes to `profiles` only, but "it writes to a different table" is
     * a claim about code that a test can make about data.
     */
    const { profilesService } = await services();
    const { account, profileIds } = await makeAccount("nopwchange", {});

    const before = await sql!<{ password_encrypted: string; updated_at: Date }[]>`
      select password_encrypted, updated_at from public.accounts where id = ${account.id}::uuid
    `;

    const result = await profilesService.updateProfile(
      profileIds[0]!,
      {
        profileName: "Renamed",
        pin: "7777",
        customerPhone: "0663947123",
        durationDays: 30,
      },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);

    const after = await sql!<{ password_encrypted: string }[]>`
      select password_encrypted from public.accounts where id = ${account.id}::uuid
    `;

    expect(after[0]!.password_encrypted).toBe(before[0]!.password_encrypted);
  }, 150_000);

  it("ignores account fields smuggled into the payload", async () => {
    /*
     * A crafted Server Action call carrying account columns. The schema strips
     * them (pinned in profile-edit-allowlist.test.ts); this proves the DATABASE
     * is unchanged too, which is the property that actually matters.
     */
    const { profilesService } = await services();
    const { account, profileIds } = await makeAccount("smuggle", { profileSlots: 2 });

    const before = await sql!<{ profile_slots: number; password_encrypted: string }[]>`
      select profile_slots, password_encrypted from public.accounts where id = ${account.id}::uuid
    `;

    await profilesService.updateProfile(
      profileIds[0]!,
      {
        profileName: "Legit change",
        /* None of these are in the allowlist. */
        accountId: "88888888-8888-4888-8888-888888888888",
        profileNumber: 5,
        status: "available",
        profileSlots: 5,
        passwordEncrypted: "v1:attacker:controlled:value",
        password: "attacker-password",
      } as Record<string, unknown>,
      { actor: superAdmin },
    );

    const after = await sql!<{ profile_slots: number; password_encrypted: string }[]>`
      select profile_slots, password_encrypted from public.accounts where id = ${account.id}::uuid
    `;

    expect(after[0]!.profile_slots).toBe(before[0]!.profile_slots);
    expect(after[0]!.password_encrypted).toBe(before[0]!.password_encrypted);

    /* And the profile did not move account or number. */
    const profile = await sql!<{ account_id: string; profile_number: number; status: string }[]>`
      select account_id, profile_number, status from public.profiles
      where id = ${profileIds[0]!}::uuid
    `;

    expect(profile[0]!.account_id).toBe(account.id);
    expect(profile[0]!.profile_number).toBe(1);
    /* Untouched: no customer was attached, so no allocation transition. */
    expect(profile[0]!.status).toBe("available");
  }, 150_000);
});

describe.skipIf(!configured)("server authority", () => {
  it("validates against the CURRENT row, not the submitted one", async () => {
    /*
     * A stale form: the dialog was opened while the account was open-ended, and
     * the account's validity was tightened before Save was pressed. The edit
     * must be judged against what the lock finds now.
     */
    const { profilesService } = await services();
    const { account, profileIds } = await makeAccount("stale", {});

    await sql!`
      update public.accounts set valid_until = current_date + 10
      where id = ${account.id}::uuid
    `;

    const result = await profilesService.updateProfile(
      profileIds[0]!,
      {
        customerPhone: "0663947122",
        expirationDate: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
        durationDays: 90,
      },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
  }, 150_000);

  it("refuses to edit a profile that no longer exists", async () => {
    const { profilesService } = await services();

    const result = await profilesService.updateProfile(
      "11111111-1111-4111-8111-111111111111",
      { profileName: "Ghost" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
  }, 60_000);
});
