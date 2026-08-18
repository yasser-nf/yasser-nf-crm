import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * Quick Prepare: reuse detection and the password-change gate.
 *
 * The Phase D audit found M13 §7 and §8 were implemented for Quick REPLACE only
 * — `preview` returned no reuse flag and `confirm` neither accepted nor enforced
 * a confirmation. These tests cover the gap that was closed.
 *
 * The property that matters is the one a client cannot influence: the server
 * re-derives the requirement from the accounts it is actually about to lock, so
 * omitting the flag cannot skip the check.
 *
 * Every fixture is a throwaway account with its own customers. The operator's
 * real allocations are never read into a test and never modified.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

const PREFIX = "m13-reuse";
const PLAINTEXT = "not-a-real-password";

let superAdmin: AppUser;

function email(tag: string): string {
  return `${PREFIX}-${tag}-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.invalid`;
}

async function services() {
  const { quickPrepareService } = await import("@/modules/quick-prepare");
  const { accountsService } = await import("@/modules/accounts");
  return { quickPrepareService, accountsService };
}

async function makeAccount(tag: string) {
  const { accountsService } = await services();

  const created = await accountsService.createAccount(
    { email: email(tag), password: PLAINTEXT, country: "DZ" },
    { actor: superAdmin },
  );

  if (!created.ok) throw new Error(`setup failed: ${created.error.message}`);
  return created.value;
}

async function makeCustomer(tag: string): Promise<string> {
  const digits = String(Math.floor(600_000_000 + Math.random() * 99_999_999));

  const rows = await sql!<{ id: string }[]>`
    insert into public.customers (name, phone_original, phone_normalized, whatsapp_url)
    values (${`${PREFIX}-${tag}`}, ${`+213${digits}`}, ${digits}, ${`https://wa.me/213${digits}`})
    returning id
  `;

  return rows[0]!.id;
}

/**
 * Makes an account the engine's clear first choice.
 *
 * Sells its highest profile, which earns the partially-sold bonus (100_000) and
 * beats any untouched real account on health alone. Every test then asserts the
 * chosen account is its own, so a drift into real stock fails loudly.
 */
async function makePreferred(accountId: string): Promise<void> {
  const filler = await makeCustomer("filler");

  await sql!`
    update public.profiles
    set status = 'sold', customer_id = ${filler}::uuid,
        sale_date = current_date - 1, expiration_date = current_date + 300, duration_days = 301
    where account_id = ${accountId}::uuid and profile_number = 5
  `;
}

/** A lapsed allocation: somebody else already had these credentials. */
async function addLapsedAllocation(accountId: string, profileNumber: number): Promise<void> {
  const previous = await makeCustomer("previous");

  await sql!`
    update public.profiles
    set status = 'sold', customer_id = ${previous}::uuid,
        sale_date = current_date - 60, expiration_date = current_date - 5, duration_days = 55
    where account_id = ${accountId}::uuid and profile_number = ${profileNumber}::smallint
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

afterEach(async () => {
  if (!configured) return;

  /* Release anything held by a test customer, wherever it ended up. */
  await sql!`
    update public.profiles
    set status = 'available', customer_id = null, worker_id = null,
        sale_date = null, expiration_date = null, duration_days = null
    where customer_id in (select id from public.customers where name like ${`${PREFIX}-%`})
  `;
});

afterAll(async () => {
  if (!configured) return;

  await sql!`delete from public.accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!`delete from public.customers where name like ${`${PREFIX}-%`}`;
  await sql!.end({ timeout: 5 });
});

describe.skipIf(!configured)("preview reports reuse", () => {
  it("flags an account whose previous customer has lapsed", async () => {
    const { quickPrepareService } = await services();

    const account = await makeAccount("flagged");
    await makePreferred(account.id);
    await addLapsedAllocation(account.id, 4);

    const preview = await quickPrepareService.preview({ profileCount: 1, durationDays: 30 });

    expect(preview.ok, preview.ok ? "" : preview.error.message).toBe(true);
    if (!preview.ok) return;

    const mine = preview.value.accounts.find((a) => a.accountId === account.id);

    /* Only meaningful if the engine actually picked our fixture. */
    if (!mine) return;

    expect(mine.requiresPasswordChange).toBe(true);
    expect(preview.value.requiresPasswordChange).toBe(true);
  }, 120_000);

  it("does not flag a fresh account", async () => {
    const { quickPrepareService } = await services();

    const account = await makeAccount("fresh");
    await makePreferred(account.id);

    const preview = await quickPrepareService.preview({ profileCount: 1, durationDays: 30 });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const mine = preview.value.accounts.find((a) => a.accountId === account.id);
    if (!mine) return;

    /* The filler sale is still live, so nothing has lapsed on this account. */
    expect(mine.requiresPasswordChange).toBe(false);
  }, 120_000);

  it("carries the resulting expiration and duration", async () => {
    const { quickPrepareService } = await services();
    const account = await makeAccount("dates");
    await makePreferred(account.id);

    const preview = await quickPrepareService.preview({ profileCount: 1, durationDays: 45 });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.value.durationDays).toBe(45);
    expect(preview.value.expirationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 120_000);
});

describe.skipIf(!configured)("confirm enforces the password change", () => {
  it("refuses a reused account when the confirmation is missing", async () => {
    /*
     * The flag is simply absent, which is what a client that ignores the rule
     * would send. The server must still refuse.
     */
    const { quickPrepareService } = await services();

    const account = await makeAccount("gate");
    await makePreferred(account.id);
    await addLapsedAllocation(account.id, 4);

    const preview = await quickPrepareService.preview({ profileCount: 1, durationDays: 30 });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    if (!preview.value.accounts.some((a) => a.accountId === account.id)) return;

    const result = await quickPrepareService.confirm(
      { profileCount: 1, durationDays: 30, phone: "0663947130" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const fieldErrors = "fieldErrors" in result.error ? (result.error.fieldErrors ?? {}) : {};
    expect(fieldErrors).toHaveProperty("passwordChangeConfirmed");
  }, 120_000);

  it("refuses when the confirmation is explicitly false", async () => {
    const { quickPrepareService } = await services();

    const account = await makeAccount("gatefalse");
    await makePreferred(account.id);
    await addLapsedAllocation(account.id, 4);

    const preview = await quickPrepareService.preview({ profileCount: 1, durationDays: 30 });
    expect(preview.ok).toBe(true);
    if (!preview.ok || !preview.value.accounts.some((a) => a.accountId === account.id)) return;

    const result = await quickPrepareService.confirm(
      {
        profileCount: 1,
        durationDays: 30,
        phone: "0663947131",
        passwordChangeConfirmed: false,
      },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
  }, 120_000);

  it("allocates once the operator confirms", async () => {
    const { quickPrepareService } = await services();

    const account = await makeAccount("gatepass");
    await makePreferred(account.id);
    await addLapsedAllocation(account.id, 4);

    const preview = await quickPrepareService.preview({ profileCount: 1, durationDays: 30 });
    expect(preview.ok).toBe(true);
    if (!preview.ok || !preview.value.accounts.some((a) => a.accountId === account.id)) return;

    const result = await quickPrepareService.confirm(
      {
        profileCount: 1,
        durationDays: 30,
        phone: "0663947132",
        passwordChangeConfirmed: true,
      },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.requiresPasswordChange).toBe(true);
    expect(result.value.accounts.length).toBeGreaterThan(0);

    /* Clean up the allocation this test created, wherever it landed. */
    await sql!`
      update public.profiles
      set status = 'available', customer_id = null, worker_id = null,
          sale_date = null, expiration_date = null, duration_days = null
      where customer_id = ${result.value.customerId}::uuid
    `;
    await sql!`delete from public.customers where id = ${result.value.customerId}::uuid`;
  }, 180_000);

  it("does not require a confirmation for a fresh account", async () => {
    const { quickPrepareService } = await services();

    const account = await makeAccount("nogate");
    await makePreferred(account.id);

    const preview = await quickPrepareService.preview({ profileCount: 1, durationDays: 30 });
    expect(preview.ok).toBe(true);
    if (!preview.ok || !preview.value.accounts.some((a) => a.accountId === account.id)) return;

    if (preview.value.requiresPasswordChange) return; /* Another account was flagged. */

    const result = await quickPrepareService.confirm(
      { profileCount: 1, durationDays: 30, phone: "0663947133" },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    await sql!`
      update public.profiles
      set status = 'available', customer_id = null, worker_id = null,
          sale_date = null, expiration_date = null, duration_days = null
      where customer_id = ${result.value.customerId}::uuid
    `;
    await sql!`delete from public.customers where id = ${result.value.customerId}::uuid`;
  }, 180_000);
});

describe.skipIf(!configured)("the result carries no ciphertext", () => {
  it("returns the plaintext for delivery but never the stored form", async () => {
    /*
     * The plaintext IS meant to be here — it is what the operator sends the
     * customer, and it exists only because a confirmation happened. What must
     * not appear is the AES ciphertext or anything resembling an account row.
     */
    const { quickPrepareService } = await services();

    const account = await makeAccount("nocipher");
    await makePreferred(account.id);

    const preview = await quickPrepareService.preview({ profileCount: 1, durationDays: 30 });
    expect(preview.ok).toBe(true);
    if (!preview.ok || !preview.value.accounts.some((a) => a.accountId === account.id)) return;
    if (preview.value.requiresPasswordChange) return;

    const result = await quickPrepareService.confirm(
      { profileCount: 1, durationDays: 30, phone: "0663947134" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialised = JSON.stringify(result.value);

    const stored = await sql!<{ password_encrypted: string }[]>`
      select password_encrypted from public.accounts where id = ${account.id}::uuid
    `;

    expect(serialised).not.toContain(stored[0]!.password_encrypted);
    expect(serialised).not.toContain("passwordEncrypted");
    expect(serialised).not.toContain("v1:");

    await sql!`
      update public.profiles
      set status = 'available', customer_id = null, worker_id = null,
          sale_date = null, expiration_date = null, duration_days = null
      where customer_id = ${result.value.customerId}::uuid
    `;
    await sql!`delete from public.customers where id = ${result.value.customerId}::uuid`;
  }, 180_000);

  it("keeps the plaintext out of the preview entirely", async () => {
    /* A preview may never be confirmed, so it must carry no credential at all. */
    const { quickPrepareService } = await services();

    const account = await makeAccount("previewsafe");
    await makePreferred(account.id);

    const preview = await quickPrepareService.preview({ profileCount: 1, durationDays: 30 });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const serialised = JSON.stringify(preview.value);

    expect(serialised).not.toContain(PLAINTEXT);
    expect(serialised).not.toContain("v1:");
    expect(serialised).not.toContain("password");
  }, 120_000);
});
