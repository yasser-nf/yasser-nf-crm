import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * A sale that cannot be delivered must not be committed. M12 P0-1.
 *
 * `buildCredentials` used to run AFTER the transaction committed. When the
 * ciphertext could not be decrypted — tampered row, or `ENCRYPTION_KEY` rotated
 * since it was written — the allocation was already permanent and the operator
 * saw only a generic error.
 *
 * In Quick Prepare that was worse than confusing. The operator retried, and
 * every retry allocated MORE profiles: three disappeared that way during Phase D
 * before the cause was understood. Nothing in the flow was idempotent, because
 * nothing was supposed to fail after the commit.
 *
 * Decryption now happens inside the transaction, before any write. These tests
 * reproduce the original failure with a genuinely undecryptable ciphertext and
 * assert the property that was missing: a failed decryption consumes nothing.
 *
 * SAFETY AGAINST TOUCHING REAL DATA
 *
 * Quick Prepare allocates from whatever stock ranks highest, which includes real
 * accounts. Each test here gives its own account a sold profile to earn the
 * engine's partially-sold bonus, and then ASSERTS via `preview` that the account
 * it is about to confirm against is its own — so a mis-ranked run fails loudly
 * instead of quietly allocating real stock to a test customer.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

const PREFIX = "m12-crypt";
const PLAINTEXT = "not-a-real-password";

/**
 * Well-formed shape, unreadable content.
 *
 * Four `:` segments and the `v1` version, so it passes the format check and
 * reaches the cipher — where the authentication tag fails. That is the real
 * production failure mode (tampering or a rotated key), not a parse error.
 */
const CORRUPT_CIPHERTEXT = "v1:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbb:cccccccccccc";

let superAdmin: AppUser;

function email(name: string): string {
  return `${PREFIX}-${name}-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.invalid`;
}

async function services() {
  const { quickPrepareService } = await import("@/modules/quick-prepare");
  const { accountsService } = await import("@/modules/accounts");
  return { quickPrepareService, accountsService };
}

async function makeCustomer(tag: string): Promise<{ id: string; phone: string }> {
  const digits = String(Math.floor(600_000_000 + Math.random() * 99_999_999));

  const rows = await sql!<{ id: string }[]>`
    insert into public.customers (name, phone_original, phone_normalized, whatsapp_url)
    values (${`${PREFIX}-${tag}`}, ${`+213${digits}`}, ${digits}, ${`https://wa.me/213${digits}`})
    returning id
  `;

  return { id: rows[0]!.id, phone: `0${digits}` };
}

async function makeAccount(tag: string): Promise<{ id: string; email: string }> {
  const { accountsService } = await services();
  const address = email(tag);

  const result = await accountsService.createAccount(
    { email: address, password: PLAINTEXT, country: "DZ", profileSlots: 5 },
    { actor: superAdmin },
  );

  if (!result.ok) throw new Error(`could not create ${tag}: ${result.error.message}`);

  return { id: result.value.id, email: address };
}

/** Replaces a real ciphertext with one that cannot be decrypted. */
async function corrupt(accountId: string): Promise<void> {
  await sql!`
    update public.accounts set password_encrypted = ${CORRUPT_CIPHERTEXT}
    where id = ${accountId}::uuid
  `;
}

async function allocate(accountId: string, profileNumber: number, customerId: string) {
  await sql!`
    update public.profiles
    set status = 'sold', customer_id = ${customerId}::uuid,
        sale_date = current_date - 10, expiration_date = current_date + 60, duration_days = 70
    where account_id = ${accountId}::uuid and profile_number = ${profileNumber}::smallint
  `;
}

/** Earns the partially-sold bonus so this account outranks untouched real stock. */
async function makePreferred(accountId: string): Promise<void> {
  const filler = await makeCustomer("filler");
  await allocate(accountId, 5, filler.id);
}

async function soldCount(accountId: string): Promise<number> {
  const rows = await sql!<{ n: number }[]>`
    select count(*)::int as n from public.profiles
    where account_id = ${accountId}::uuid and status = 'sold'
  `;
  return rows[0]!.n;
}

async function heldAnywhere(customerId: string): Promise<number> {
  const rows = await sql!<{ n: number }[]>`
    select count(*)::int as n from public.profiles where customer_id = ${customerId}::uuid
  `;
  return rows[0]!.n;
}

async function eventCount(customerId: string): Promise<number> {
  const rows = await sql!<{ n: number }[]>`
    select count(*)::int as n from public.profile_events where customer_id = ${customerId}::uuid
  `;
  return rows[0]!.n;
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

describe.skipIf(!configured)("Quick Prepare — undecryptable stock consumes nothing", () => {
  it("refuses, and three retries in a row still allocate zero profiles", async () => {
    /*
     * The Phase D failure, reproduced. Previously each of these three calls
     * would have committed an allocation and then failed to decrypt, burning a
     * profile per attempt.
     */
    const { quickPrepareService } = await services();

    const account = await makeAccount("qp-corrupt");
    await makePreferred(account.id);
    await corrupt(account.id);

    const customer = await makeCustomer("qp");

    /* The filler occupies profile 5; four remain sellable. */
    const before = await soldCount(account.id);
    expect(before).toBe(1);

    /*
     * Confirm that the engine really is about to hand us OUR account. If stock
     * ranking ever changed, this fails here rather than allocating real stock.
     */
    const preview = await quickPrepareService.preview({ profileCount: 1, durationDays: 30 });
    expect(preview.ok, preview.ok ? "" : preview.error.message).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.accounts[0]?.accountId).toBe(account.id);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await quickPrepareService.confirm(
        {
          profileCount: 1,
          durationDays: 30,
          phone: customer.phone,
          passwordChangeConfirmed: true,
        },
        { actor: superAdmin },
      );

      expect(result.ok, `attempt ${attempt} should have been refused`).toBe(false);
    }

    /* The whole point: nothing was consumed, by any attempt. */
    expect(await soldCount(account.id)).toBe(before);
    expect(await heldAnywhere(customer.id)).toBe(0);
    expect(await eventCount(customer.id)).toBe(0);
  }, 180_000);

  it("still allocates normally when the ciphertext is readable", async () => {
    /*
     * The other half of the acceptance criterion. Moving decryption earlier must
     * not have changed the success path — a readable account still sells, and
     * still returns the plaintext the result screen renders.
     */
    const { quickPrepareService } = await services();

    const account = await makeAccount("qp-valid");
    await makePreferred(account.id);

    const customer = await makeCustomer("qp-ok");

    const preview = await quickPrepareService.preview({ profileCount: 1, durationDays: 30 });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.accounts[0]?.accountId).toBe(account.id);

    const result = await quickPrepareService.confirm(
      { profileCount: 1, durationDays: 30, phone: customer.phone, passwordChangeConfirmed: true },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.accounts).toHaveLength(1);
    expect(result.value.accounts[0]!.accountId).toBe(account.id);
    expect(result.value.accounts[0]!.password).toBe(PLAINTEXT);
    expect(result.value.clipboardText).toContain(PLAINTEXT);

    /* And it really did allocate: filler + this sale. */
    expect(await soldCount(account.id)).toBe(2);
  }, 180_000);
});

describe.skipIf(!configured)("Quick Replace — undecryptable replacement releases nothing", () => {
  it("leaves the customer on their original allocation", async () => {
    /*
     * The worse shape of the same bug: the release and the re-allocation had
     * already committed, so the customer had been moved onto an account whose
     * password nobody could read.
     */
    const { quickPrepareService } = await services();

    const broken = await makeAccount("qr-old");
    const customer = await makeCustomer("qr");
    await allocate(broken.id, 1, customer.id);

    const replacement = await makeAccount("qr-new");
    await makePreferred(replacement.id);
    await corrupt(replacement.id);

    const held = await sql!<{ id: string }[]>`
      select id from public.profiles
      where account_id = ${broken.id}::uuid and customer_id = ${customer.id}::uuid
    `;

    const beforeReplacementSold = await soldCount(replacement.id);

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer.id,
        expectedProfileIds: held.map((row) => row.id),
        replacementAccountId: replacement.id,
        passwordChangeConfirmed: true,
      },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);

    /* The original allocation is untouched — status, owner and dates. */
    const after = await sql!<
      { status: string; customer_id: string | null; expiration_date: string | null }[]
    >`
      select status, customer_id, to_char(expiration_date, 'YYYY-MM-DD') as expiration_date
      from public.profiles
      where account_id = ${broken.id}::uuid and profile_number = 1
    `;

    expect(after[0]!.status).toBe("sold");
    expect(after[0]!.customer_id).toBe(customer.id);
    expect(after[0]!.expiration_date).not.toBeNull();

    /* The replacement account gained nothing. */
    expect(await soldCount(replacement.id)).toBe(beforeReplacementSold);

    /* And no history was written for a replacement that never happened. */
    expect(await eventCount(customer.id)).toBe(0);
  }, 180_000);
});
