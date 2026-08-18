import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * What the accounts list actually sends to the browser.
 *
 * Two separate properties, both asserted against a real query:
 *
 *   1. Every account row carries exactly five profile indicators, in the right
 *      states — the data behind M13 §1's P1..P5 cells.
 *   2. The payload carries NO credential. Not the plaintext (which never
 *      existed here) and not the AES ciphertext, and no profile PIN.
 *
 * The second is the one that needs a test rather than a review. `AccountRow`
 * includes `password_encrypted`, and the list component is a Client Component,
 * so before Phase C every ciphertext was serialized into the RSC payload where
 * it sat in the HTML source. Nothing failed; it was simply visible. A test is
 * the only thing that keeps it gone.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

const PREFIX = "m13-list";
const PLAINTEXT = "not-a-real-password-for-the-list";
const PIN = "4821";

let superAdmin: AppUser;
let accountId: string;
let accountEmail: string;

beforeAll(async () => {
  if (!configured) return;

  const { accountsService } = await import("@/modules/accounts");

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

  accountEmail = `${PREFIX}-${Date.now()}@example.invalid`;

  /* Three sellable slots of five, so two are permanently not for sale. */
  const created = await accountsService.createAccount(
    { email: accountEmail, password: PLAINTEXT, country: "DZ", profileSlots: 3 },
    { actor: superAdmin },
  );

  if (!created.ok) throw new Error(`setup failed: ${created.error.message}`);
  accountId = created.value.id;

  const customers = await sql!<{ id: string }[]>`
    select id from public.customers where deleted_at is null limit 1
  `;

  /* Profile 1 live, profile 2 lapsed, profile 3 free, 4 and 5 out of stock. */
  if (customers.length > 0) {
    await sql!`
      update public.profiles
      set status = 'sold', customer_id = ${customers[0]!.id}::uuid, pin = ${PIN},
          sale_date = current_date - 10, expiration_date = current_date + 20, duration_days = 30
      where account_id = ${accountId}::uuid and profile_number = 1
    `;

    await sql!`
      update public.profiles
      set status = 'sold', customer_id = ${customers[0]!.id}::uuid, pin = ${PIN},
          sale_date = current_date - 60, expiration_date = current_date - 5, duration_days = 55
      where account_id = ${accountId}::uuid and profile_number = 2
    `;
  }
});

afterAll(async () => {
  if (!configured) return;

  await sql!`delete from public.accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!.end({ timeout: 5 });
});

async function listRow() {
  const { accountsService } = await import("@/modules/accounts");
  const result = await accountsService.listAccounts({ search: accountEmail });

  if (!result.ok) throw new Error(`listAccounts failed: ${result.error.message}`);

  const row = result.value.items.find((item) => item.account.id === accountId);
  if (!row) throw new Error("the account under test was not returned");

  return { row, page: result.value };
}

describe.skipIf(!configured)("profile indicators", () => {
  it("returns exactly five indicators, numbered 1 to 5", async () => {
    const { row } = await listRow();

    expect(row.indicators).toHaveLength(5);
    expect(row.indicators.map((i) => i.profileNumber)).toEqual([1, 2, 3, 4, 5]);
  }, 90_000);

  it("marks slots above profile_slots as not for sale", async () => {
    const { row } = await listRow();
    const states = new Map(row.indicators.map((i) => [i.profileNumber, i.state]));

    expect(row.account.profileSlots).toBe(3);
    expect(states.get(4)).toBe("not_for_sale");
    expect(states.get(5)).toBe("not_for_sale");
  }, 90_000);

  it("marks a live allocation sold and a lapsed one expired", async () => {
    const customers = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.customers where deleted_at is null
    `;

    if (customers[0]!.n === 0) return;

    const { row } = await listRow();
    const states = new Map(row.indicators.map((i) => [i.profileNumber, i.state]));

    expect(states.get(1)).toBe("sold");
    /* Still `sold` in the column — the DATE is what makes it expired. */
    expect(states.get(2)).toBe("expired");
  }, 90_000);

  it("marks a free sellable slot as available", async () => {
    const { row } = await listRow();
    const states = new Map(row.indicators.map((i) => [i.profileNumber, i.state]));

    expect(states.get(3)).toBe("available");
  }, 90_000);

  it("counts available stock without the not-for-sale slots", async () => {
    const { row } = await listRow();

    /* Three sellable, one live, one lapsed-and-therefore-free again. */
    expect(row.notForSaleProfiles).toBe(2);
    expect(row.availableProfiles).toBeLessThanOrEqual(3);
  }, 90_000);

  it("reports open-ended validity as null rather than a date", async () => {
    const { row } = await listRow();

    expect(row.account.validUntil).toBeNull();
    expect(row.remainingValidityDays).toBeNull();
  }, 90_000);
});

describe.skipIf(!configured)("the payload carries no credential", () => {
  it("omits passwordEncrypted from every account in the page", async () => {
    const { page } = await listRow();

    for (const item of page.items) {
      expect(item.account).not.toHaveProperty("passwordEncrypted");
    }
  }, 90_000);

  it("contains neither the plaintext nor the ciphertext anywhere in the payload", async () => {
    /*
     * Serialised whole, the way Next serialises props for a Client Component.
     * If any nested field ever carries the credential, this finds it.
     */
    const { page } = await listRow();
    const serialised = JSON.stringify(page);

    expect(serialised).not.toContain(PLAINTEXT);

    const stored = await sql!<{ password_encrypted: string }[]>`
      select password_encrypted from public.accounts where id = ${accountId}::uuid
    `;

    expect(serialised).not.toContain(stored[0]!.password_encrypted);
    /* And not even the ciphertext's distinctive prefix plus body. */
    expect(serialised).not.toContain(stored[0]!.password_encrypted.slice(0, 24));
  }, 90_000);

  it("does not ship profile PINs or raw profile rows", async () => {
    const customers = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.customers where deleted_at is null
    `;

    const { row, page } = await listRow();

    expect(row).not.toHaveProperty("profiles");

    if (customers[0]!.n > 0) {
      expect(JSON.stringify(page)).not.toContain(PIN);
    }
  }, 90_000);

  it("omits the credential from the account DETAIL payload too", async () => {
    /*
     * The detail page passes `account` into AccountHeader, a Client Component,
     * so the same leak existed there. Asserted separately because it is a
     * different service method with its own projection.
     */
    const { accountsService } = await import("@/modules/accounts");
    const detail = await accountsService.getAccountDetail(accountId);

    expect(detail.ok).toBe(true);
    if (!detail.ok) return;

    expect(detail.value.account).not.toHaveProperty("passwordEncrypted");

    const stored = await sql!<{ password_encrypted: string }[]>`
      select password_encrypted from public.accounts where id = ${accountId}::uuid
    `;

    /*
     * Only the account projection is checked, not the whole detail value:
     * `profiles` intentionally carries full rows because the profile cards
     * render PINs, which is a UI need rather than a leak.
     */
    expect(JSON.stringify(detail.value.account)).not.toContain(stored[0]!.password_encrypted);
    expect(JSON.stringify(detail.value.account)).not.toContain(PLAINTEXT);
  }, 90_000);

  it("derives the same five indicator states on the detail page as on the list", async () => {
    /* M13 §7: one interpretation, two screens. */
    const { accountsService } = await import("@/modules/accounts");

    const detail = await accountsService.getAccountDetail(accountId);
    const { row } = await listRow();

    expect(detail.ok).toBe(true);
    if (!detail.ok) return;

    expect(detail.value.indicators.map((i) => [i.profileNumber, i.state])).toEqual(
      row.indicators.map((i) => [i.profileNumber, i.state]),
    );
  }, 90_000);

  it("reports the account's remaining validity on the detail payload", async () => {
    const { accountsService } = await import("@/modules/accounts");
    const detail = await accountsService.getAccountDetail(accountId);

    expect(detail.ok).toBe(true);
    if (!detail.ok) return;

    /* Open-ended, so null rather than a misleading number. */
    expect(detail.value.remainingValidityDays).toBeNull();
    expect(detail.value.account.validUntil).toBeNull();
    expect(detail.value.account.profileSlots).toBe(3);
  }, 90_000);

  it("still carries what the list needs to render", async () => {
    /* The projection must not have stripped so much that the UI breaks. */
    const { row } = await listRow();

    expect(row.account.email).toBe(accountEmail);
    expect(row.account.status).toBe("healthy");
    expect(row.account.profileSlots).toBe(3);
    expect(typeof row.account.healthScore).toBe("number");
  }, 90_000);
});
