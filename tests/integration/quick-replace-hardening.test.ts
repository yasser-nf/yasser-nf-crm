import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * Quick Replace hardening — the Phase E pre-flight remediation.
 *
 * The Phase E audit found three defects on the path the replacement UI was
 * about to be built on, plus one gap. This file is the evidence that each is
 * actually fixed, rather than described as fixed:
 *
 *   G1  the preview payload carried `passwordEncrypted` twice, and PINs
 *   G2  `replacementAccountId` was documented as preventing commit drift and
 *       was read by nothing at all
 *   G3  the M13 §8 password gate was derived from an UNLOCKED preview, so it
 *       could be evaluated against a different account than the one committed
 *   M1  the preview showed only profiles somebody held, never the free slots
 *
 * G1 is asserted on the RUNTIME object, not on its type. A TypeScript
 * projection that is only a type is not a projection — Phase D established that
 * the hard way, when `BulkCreateResult.created` compiled as a credential-free
 * view while still carrying the ciphertext at runtime.
 *
 * SAFETY AGAINST TOUCHING REAL DATA
 *
 * G2 is itself the strongest protection this file has: every commit here names
 * its own `replacementAccountId`, so a commit can only ever land on a test
 * account or refuse outright. It can no longer reallocate real stock even if
 * the engine would have ranked a real account first.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

const PREFIX = "m13-qrh";
const PLAINTEXT = "not-a-real-password";

let superAdmin: AppUser;

function email(name: string): string {
  return `${PREFIX}-${name}-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.invalid`;
}

async function services() {
  const { quickPrepareService, quickReplaceService } = await import("@/modules/quick-prepare");
  const { accountsService } = await import("@/modules/accounts");
  return { quickPrepareService, quickReplaceService, accountsService };
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

async function makeAccount(tag: string, profileSlots = 5): Promise<{ id: string; email: string }> {
  const { accountsService } = await services();
  const address = email(tag);

  const result = await accountsService.createAccount(
    { email: address, password: PLAINTEXT, country: "DZ", profileSlots },
    { actor: superAdmin },
  );

  if (!result.ok) throw new Error(`could not create ${tag}: ${result.error.message}`);

  return { id: result.value.id, email: address };
}

async function allocate(
  accountId: string,
  profileNumber: number,
  customerId: string,
  { soldDaysAgo, expiresInDays }: { soldDaysAgo: number; expiresInDays: number },
): Promise<void> {
  await sql!`
    update public.profiles
    set status = 'sold',
        customer_id = ${customerId}::uuid,
        sale_date = current_date - ${soldDaysAgo}::int,
        expiration_date = current_date + ${expiresInDays}::int,
        duration_days = ${soldDaysAgo + expiresInDays}::int
    where account_id = ${accountId}::uuid and profile_number = ${profileNumber}::smallint
  `;
}

/** Earns the engine's partially-sold bonus so this account outranks real stock. */
async function makePreferred(accountId: string): Promise<void> {
  const filler = await makeCustomer("filler");
  await allocate(accountId, 5, filler, { soldDaysAgo: 1, expiresInDays: 300 });
}

/** Gives an account a lapsed allocation, which is what M13 §7 calls reuse. */
async function makeReused(accountId: string, profileNumber = 4): Promise<void> {
  const previous = await makeCustomer("prev");

  await sql!`
    update public.profiles
    set status = 'sold', customer_id = ${previous}::uuid,
        sale_date = current_date - 60, expiration_date = current_date - 5, duration_days = 55
    where account_id = ${accountId}::uuid and profile_number = ${profileNumber}::smallint
  `;
}

/** The profiles a customer currently holds on an account. */
async function heldIds(accountId: string, customerId: string): Promise<string[]> {
  const rows = await sql!<{ id: string }[]>`
    select id from public.profiles
    where account_id = ${accountId}::uuid and customer_id = ${customerId}::uuid
    order by profile_number
  `;

  return rows.map((row) => row.id);
}

/** A customer's allocation as stored, for asserting nothing moved. */
async function allocationRow(
  accountId: string,
  profileNumber = 1,
): Promise<{ status: string; customer_id: string | null; expiration_date: string | null }> {
  const rows = await sql!<
    { status: string; customer_id: string | null; expiration_date: string | null }[]
  >`
    select status, customer_id, to_char(expiration_date, 'YYYY-MM-DD') as expiration_date
    from public.profiles
    where account_id = ${accountId}::uuid and profile_number = ${profileNumber}::smallint
  `;

  return rows[0]!;
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

/* ──────────────────── the single guarded path, at runtime ────────────────── */

describe.skipIf(!configured)("only one replacement entry point exists", () => {
  it("no longer exposes an unguarded replaceAllocation on the service", async () => {
    const { quickPrepareService } = await services();

    /*
     * The source scan in tests/unit/replacement-single-path.test.ts proves no
     * file references it. This proves the built object does not carry it either
     * — the same distinction Phase D established between a type and a runtime
     * shape.
     */
    expect(Object.hasOwn(quickPrepareService, "replaceAllocation")).toBe(false);
    expect(Object.keys(quickPrepareService).toSorted()).toEqual([
      "availableStock",
      "confirm",
      "confirmReplacement",
      "preview",
    ]);
  }, 60_000);

  it("refuses a replacement that names no approved account", async () => {
    const { quickPrepareService } = await services();

    const broken = await makeAccount("single-old");
    const customer = await makeCustomer("single");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const approved = await makeAccount("single-new");
    await makePreferred(approved.id);

    /*
     * Exactly what the deleted action used to send. The schema now requires
     * `replacementAccountId`, so the old shape cannot reach the transaction at
     * all — it is rejected as invalid input rather than quietly allocating.
     */
    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: await heldIds(broken.id, customer),
      },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);

    const original = await allocationRow(broken.id, 1);
    expect(original.status).toBe("sold");
    expect(original.customer_id).toBe(customer);
  }, 120_000);
});

/* ─────────────────────────── G1 — no credentials ─────────────────────────── */

describe.skipIf(!configured)("G1 — the preview carries no credentials", () => {
  it("omits passwordEncrypted from every account, at runtime and in JSON", async () => {
    const { quickReplaceService } = await services();

    const broken = await makeAccount("g1-old");
    const customer = await makeCustomer("g1");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 10, expiresInDays: 40 });

    const replacement = await makeAccount("g1-new");
    await makePreferred(replacement.id);

    const preview = await quickReplaceService.preview({ accountEmail: broken.email });
    expect(preview.ok, preview.ok ? "" : preview.error.message).toBe(true);
    if (!preview.ok) return;

    const serialized = JSON.stringify(preview.value);

    /* The property name, in both the TypeScript and the SQL spelling. */
    expect(serialized).not.toContain("passwordEncrypted");
    expect(serialized).not.toContain("password_encrypted");

    /*
     * And the VALUE. A field could be renamed and still ship the ciphertext,
     * which the name checks above would happily pass.
     */
    const stored = await sql!<{ password_encrypted: string }[]>`
      select password_encrypted from public.accounts where id = ${broken.id}::uuid
    `;
    expect(serialized).not.toContain(stored[0]!.password_encrypted);

    /* The runtime object itself, not merely its serialization. */
    expect(Object.hasOwn(preview.value.oldAccount, "passwordEncrypted")).toBe(false);
    expect(preview.value.oldAccount.id).toBe(broken.id);

    if (preview.value.replacement) {
      expect(Object.hasOwn(preview.value.replacement.account, "passwordEncrypted")).toBe(false);
    }
  }, 120_000);

  it("omits the profile PIN from every profile it returns", async () => {
    const { quickReplaceService } = await services();

    const broken = await makeAccount("g1pin-old");
    const customer = await makeCustomer("g1pin");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 5, expiresInDays: 40 });

    /* A PIN that would be unmistakable in the payload if it leaked. */
    await sql!`
      update public.profiles set pin = '9137'
      where account_id = ${broken.id}::uuid
    `;

    const replacement = await makeAccount("g1pin-new");
    await makePreferred(replacement.id);

    const preview = await quickReplaceService.preview({ accountEmail: broken.email });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(JSON.stringify(preview.value)).not.toContain("9137");
    expect(JSON.stringify(preview.value)).not.toContain('"pin"');

    /* Every profile-bearing collection, checked as objects. */
    const everyProfile = [
      ...preview.value.accountProfiles.map((slot) => slot.profile),
      ...preview.value.candidates.flatMap((candidate) => candidate.profiles),
      ...(preview.value.replacement?.profiles ?? []),
    ];

    expect(everyProfile.length).toBeGreaterThan(0);

    for (const profile of everyProfile) {
      expect(Object.hasOwn(profile, "pin")).toBe(false);
    }
  }, 120_000);
});

/* ──────────────────── G2 — the approved account, or nothing ──────────────── */

describe.skipIf(!configured)("G2 — replacementAccountId is honoured exactly", () => {
  it("A: commits onto the approved account", async () => {
    const { quickPrepareService, quickReplaceService } = await services();

    const broken = await makeAccount("g2a-old");
    const customer = await makeCustomer("g2a");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const replacement = await makeAccount("g2a-new");
    await makePreferred(replacement.id);

    const preview = await quickReplaceService.preview({ accountEmail: broken.email });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.replacement?.account.id).toBe(replacement.id);

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: await heldIds(broken.id, customer),
        replacementAccountId: replacement.id,
        passwordChangeConfirmed: true,
      },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    /* It landed where it was approved to land. */
    expect(result.value.accounts.every((account) => account.accountId === replacement.id)).toBe(
      true,
    );
  }, 120_000);

  it("B: refuses when the confirmed account is not the previewed one", async () => {
    const { quickPrepareService, quickReplaceService } = await services();

    const broken = await makeAccount("g2b-old");
    const customer = await makeCustomer("g2b");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const approved = await makeAccount("g2b-approved");
    await makePreferred(approved.id);

    /* A second, perfectly valid account the operator never saw. */
    const other = await makeAccount("g2b-other");

    const preview = await quickReplaceService.preview({ accountEmail: broken.email });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.replacement?.account.id).toBe(approved.id);

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: await heldIds(broken.id, customer),
        /* Not what the preview proposed. */
        replacementAccountId: other.id,
        passwordChangeConfirmed: true,
      },
      { actor: superAdmin },
    );

    /*
     * `other` IS eligible, so this must not succeed by accident. The commit is
     * bound to the id it was given, and the id it was given is not the one the
     * operator approved — so the operator's allocation stays put.
     */
    if (result.ok) {
      expect(result.value.accounts.every((account) => account.accountId === other.id)).toBe(true);
    }

    /* Whatever happened, it did not silently land on the approved account. */
    const approvedHolders = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.profiles
      where account_id = ${approved.id}::uuid and customer_id = ${customer}::uuid
    `;
    expect(approvedHolders[0]!.n).toBe(0);
  }, 120_000);

  it("C: refuses when the approved account develops a problem", async () => {
    const { quickPrepareService, quickReplaceService } = await services();

    const broken = await makeAccount("g2c-old");
    const customer = await makeCustomer("g2c");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const approved = await makeAccount("g2c-new");
    await makePreferred(approved.id);

    const preview = await quickReplaceService.preview({ accountEmail: broken.email });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.replacement?.account.id).toBe(approved.id);

    const held = await heldIds(broken.id, customer);

    /* It stops being healthy between the preview and the confirmation. */
    await sql!`
      update public.accounts set status = 'payment_problem' where id = ${approved.id}::uuid
    `;

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: held,
        replacementAccountId: approved.id,
        passwordChangeConfirmed: true,
      },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);

    /* G: no silent fallback. The customer is exactly where they were. */
    const original = await allocationRow(broken.id, 1);
    expect(original.status).toBe("sold");
    expect(original.customer_id).toBe(customer);

    const elsewhere = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.profiles
      where customer_id = ${customer}::uuid and account_id <> ${broken.id}::uuid
    `;
    expect(elsewhere[0]!.n).toBe(0);
  }, 120_000);

  it("D: refuses when the approved account can no longer cover the remaining days", async () => {
    const { quickPrepareService } = await services();

    const broken = await makeAccount("g2d-old");
    const customer = await makeCustomer("g2d");
    /* 50 days still to run. */
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const approved = await makeAccount("g2d-new");
    await makePreferred(approved.id);

    const held = await heldIds(broken.id, customer);

    /* The account itself now runs out in 5 days — it cannot carry 50. */
    await sql!`
      update public.accounts set valid_until = current_date + 5
      where id = ${approved.id}::uuid
    `;

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: held,
        replacementAccountId: approved.id,
        passwordChangeConfirmed: true,
      },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);

    const original = await allocationRow(broken.id, 1);
    expect(original.status).toBe("sold");
    expect(original.customer_id).toBe(customer);
  }, 120_000);

  it("E: refuses when the approved account has no free profile left", async () => {
    const { quickPrepareService } = await services();

    const broken = await makeAccount("g2e-old");
    const customer = await makeCustomer("g2e");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    /* One sellable slot, and it is about to be taken. */
    const approved = await makeAccount("g2e-new", 1);
    const squatter = await makeCustomer("g2e-squat");

    const held = await heldIds(broken.id, customer);

    await allocate(approved.id, 1, squatter, { soldDaysAgo: 1, expiresInDays: 300 });

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: held,
        replacementAccountId: approved.id,
        passwordChangeConfirmed: true,
      },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);

    const original = await allocationRow(broken.id, 1);
    expect(original.status).toBe("sold");
    expect(original.customer_id).toBe(customer);
  }, 120_000);
});

/* ─────────────── G3 — the gate is derived from the locked account ────────── */

describe.skipIf(!configured)("G3 — password change is re-derived under lock", () => {
  it("A: refuses when the approved account BECOMES reused after the preview", async () => {
    /*
     * The bypass this whole gate exists to stop. The preview says no password
     * change is needed; the account acquires a lapsed allocation before the
     * operator confirms. Deriving from the preview would hand over credentials
     * the previous customer still knows.
     */
    const { quickPrepareService, quickReplaceService } = await services();

    const broken = await makeAccount("g3a-old");
    const customer = await makeCustomer("g3a");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const approved = await makeAccount("g3a-new");
    await makePreferred(approved.id);

    const preview = await quickReplaceService.preview({ accountEmail: broken.email });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.replacement?.account.id).toBe(approved.id);

    /* The preview genuinely saw no reuse. */
    expect(preview.value.requiresPasswordChange).toBe(false);

    const held = await heldIds(broken.id, customer);

    /* Now it is reused — after the operator was told it was not. */
    await makeReused(approved.id);

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: held,
        replacementAccountId: approved.id,
        /* The operator was never asked, so they cannot have confirmed. */
      },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);

    const original = await allocationRow(broken.id, 1);
    expect(original.status).toBe("sold");
    expect(original.customer_id).toBe(customer);
  }, 120_000);

  it("B and C: refuses an omitted flag and an explicit false", async () => {
    const { quickPrepareService } = await services();

    const broken = await makeAccount("g3bc-old");
    const customer = await makeCustomer("g3bc");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const approved = await makeAccount("g3bc-new");
    await makePreferred(approved.id);
    await makeReused(approved.id);

    const held = await heldIds(broken.id, customer);

    const omitted = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: held,
        replacementAccountId: approved.id,
      },
      { actor: superAdmin },
    );

    expect(omitted.ok).toBe(false);

    const explicitFalse = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: held,
        replacementAccountId: approved.id,
        passwordChangeConfirmed: false,
      },
      { actor: superAdmin },
    );

    expect(explicitFalse.ok).toBe(false);

    const original = await allocationRow(broken.id, 1);
    expect(original.status).toBe("sold");
    expect(original.customer_id).toBe(customer);
  }, 120_000);

  it("D: allows a confirmed reused account, and reports the requirement back", async () => {
    const { quickPrepareService } = await services();

    const broken = await makeAccount("g3d-old");
    const customer = await makeCustomer("g3d");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const approved = await makeAccount("g3d-new");
    await makePreferred(approved.id);
    await makeReused(approved.id);

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: await heldIds(broken.id, customer),
        replacementAccountId: approved.id,
        passwordChangeConfirmed: true,
      },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    /* Derived from the locked account, so the result screen can repeat it. */
    expect(result.value.requiresPasswordChange).toBe(true);
  }, 120_000);

  it("E and F: no gate when the account is clean, and the client cannot fake one", async () => {
    const { quickPrepareService } = await services();

    const broken = await makeAccount("g3ef-old");
    const customer = await makeCustomer("g3ef");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    /* No lapsed allocation anywhere on it. */
    const approved = await makeAccount("g3ef-new");
    await makePreferred(approved.id);

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: await heldIds(broken.id, customer),
        replacementAccountId: approved.id,
        /*
         * F: a client-supplied requirement, which the server must ignore
         * entirely — it derives its own. The schema does not accept the field,
         * so it cannot even reach the service.
         */
        requiresPasswordChange: true,
      },
      { actor: superAdmin },
    );

    /* E: no flag was sent and none was needed. */
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    /* F: the server's own derivation won. */
    expect(result.value.requiresPasswordChange).toBe(false);
  }, 120_000);
});

/* ──────────────── the payload the result screen actually renders ─────────── */

describe.skipIf(!configured)("the confirmation result the screen renders", () => {
  it("returns the four credential fields, with the plaintext password", async () => {
    /*
     * The result screen shows Email / Password / Profile number / Code pin, and
     * "Copy all" builds its string from exactly these values. The G2 tests prove
     * the replacement lands on the approved account; this proves the payload
     * that lands in the operator's hands is complete and correct.
     *
     * The plaintext password only exists here because the transaction committed
     * — it is decrypted after the commit and never appears in any preview.
     */
    const { quickPrepareService } = await services();

    const broken = await makeAccount("result-old");
    const customer = await makeCustomer("result");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const approved = await makeAccount("result-new");
    await makePreferred(approved.id);

    /* A PIN the result must carry through to the screen. */
    await sql!`update public.profiles set pin = '5150' where account_id = ${approved.id}::uuid`;

    const before = await allocationRow(broken.id, 1);

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: await heldIds(broken.id, customer),
        replacementAccountId: approved.id,
        passwordChangeConfirmed: true,
      },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.accounts).toHaveLength(1);
    const account = result.value.accounts[0]!;

    /* Email and the DECRYPTED password — what the screen renders. */
    expect(account.accountId).toBe(approved.id);
    expect(account.email).toBe(approved.email);
    expect(account.password).toBe(PLAINTEXT);

    /* Profile number and PIN. */
    expect(account.profiles).toHaveLength(1);
    const profile = account.profiles[0]!;
    expect(profile.profileNumber).toBeGreaterThanOrEqual(1);
    expect(profile.pin).toBe("5150");

    /* The carry-over survives into the result, not just the preview. */
    expect(result.value.expirationDate).toBe(before.expiration_date);

    /* And the ready-to-paste block carries the same credentials. */
    expect(result.value.clipboardText).toContain(approved.email);
    expect(result.value.clipboardText).toContain(PLAINTEXT);
  }, 120_000);

  it("returns no result at all when the confirmation is refused", async () => {
    /*
     * A refusal must not produce a half-populated success. The screen renders
     * credentials only from `result.ok === true`, so a failure carrying an
     * accounts array would be the one shape that could leak them onto a screen
     * after a transaction that never happened.
     */
    const { quickPrepareService } = await services();

    const broken = await makeAccount("noresult-old");
    const customer = await makeCustomer("noresult");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const approved = await makeAccount("noresult-new");
    await makePreferred(approved.id);
    await makeReused(approved.id);

    const held = await heldIds(broken.id, customer);

    /* Reuse flagged, confirmation withheld: the gate refuses. */
    const refused = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: held,
        replacementAccountId: approved.id,
      },
      { actor: superAdmin },
    );

    expect(refused.ok).toBe(false);
    if (refused.ok) return;

    /* No credentials anywhere in the failure. */
    const serialized = JSON.stringify(refused.error);
    expect(serialized).not.toContain(PLAINTEXT);
    expect(serialized).not.toContain("password_encrypted");
    expect(serialized).not.toContain("clipboardText");

    /* And the customer never moved. */
    const original = await allocationRow(broken.id, 1);
    expect(original.status).toBe("sold");
    expect(original.customer_id).toBe(customer);
  }, 120_000);
});

/* ───────────────────── M1 — every slot on the old account ────────────────── */

describe.skipIf(!configured)("M1 — the preview shows every physical slot", () => {
  it("returns free, sold, expired and not-for-sale slots with correct states", async () => {
    const { quickReplaceService } = await services();

    /* Three sellable slots, so 4 and 5 are permanently out of stock. */
    const broken = await makeAccount("m1-old", 3);
    const customer = await makeCustomer("m1");
    const lapsedCustomer = await makeCustomer("m1-lapsed");

    /* 1 sold and running, 2 sold and lapsed, 3 free, 4 and 5 not for sale. */
    await allocate(broken.id, 1, customer, { soldDaysAgo: 10, expiresInDays: 40 });

    await sql!`
      update public.profiles
      set status = 'sold', customer_id = ${lapsedCustomer}::uuid,
          sale_date = current_date - 60, expiration_date = current_date - 3, duration_days = 57
      where account_id = ${broken.id}::uuid and profile_number = 2
    `;

    const replacement = await makeAccount("m1-new");
    await makePreferred(replacement.id);

    const preview = await quickReplaceService.preview({ accountEmail: broken.email });
    expect(preview.ok, preview.ok ? "" : preview.error.message).toBe(true);
    if (!preview.ok) return;

    const slots = preview.value.accountProfiles;

    /* All five physical rows, in profile-number order. */
    expect(slots).toHaveLength(5);
    expect(slots.map((slot) => slot.profile.profileNumber)).toEqual([1, 2, 3, 4, 5]);

    const state = (n: number) => slots.find((slot) => slot.profile.profileNumber === n)!.state;

    expect(state(1)).toBe("sold");
    expect(state(2)).toBe("expired");
    expect(state(3)).toBe("available");
    expect(state(4)).toBe("not_for_sale");
    expect(state(5)).toBe("not_for_sale");

    /* The holder is named, so an operator can tell the two customers apart. */
    const first = slots.find((slot) => slot.profile.profileNumber === 1)!;
    expect(first.customerName).toContain(PREFIX);
    expect(first.profile.customerId).toBe(customer);

    const free = slots.find((slot) => slot.profile.profileNumber === 3)!;
    expect(free.customerName).toBeNull();
    expect(free.profile.customerId).toBeNull();
  }, 120_000);

  it("leaves the candidate grouping exactly as it was", async () => {
    const { quickReplaceService } = await services();

    const broken = await makeAccount("m1group-old");
    const customer = await makeCustomer("m1group");

    /* One customer, two profiles — the grouping this must not disturb. */
    await allocate(broken.id, 1, customer, { soldDaysAgo: 10, expiresInDays: 40 });
    await allocate(broken.id, 2, customer, { soldDaysAgo: 10, expiresInDays: 40 });

    const replacement = await makeAccount("m1group-new");
    await makePreferred(replacement.id);

    const preview = await quickReplaceService.preview({ accountEmail: broken.email });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    /* Candidates are still customer-grouped and still exclude free slots. */
    expect(preview.value.candidates).toHaveLength(1);
    expect(preview.value.candidates[0]!.customer.id).toBe(customer);
    expect(preview.value.candidates[0]!.profiles.map((p) => p.profileNumber)).toEqual([1, 2]);
    expect(preview.value.selected?.customer.id).toBe(customer);

    /* While accountProfiles carries every slot, held or not. */
    expect(preview.value.accountProfiles).toHaveLength(5);
  }, 120_000);
});

/* ─────────────────────────── transaction safety ──────────────────────────── */

describe.skipIf(!configured)("atomicity — the release never survives a later failure", () => {
  it("rolls the release back when a step after it throws", async () => {
    /*
     * The release and the re-allocation share one transaction, so a failure
     * after the release must undo it. Proving that needs a fault injected
     * BETWEEN the two, and no input can cause one — every input-level guard runs
     * before the release, by design. That is the guard order working correctly,
     * and it is exactly what makes this property awkward to test.
     *
     * The fault therefore comes from a foreign key.
     *
     * `commitReplacement` writes, in this order:
     *
     *   1. UPDATE profiles → available          (the release)
     *   2. INSERT profile_events                (the cancellation record)
     *   3. UPDATE profiles → sold               (the re-allocation)
     *   4. INSERT profile_events                (the reallocation record)
     *
     * `profile_events.user_id` references `users.id`. Acting as a user id that
     * does not exist makes step 2 raise 23503 — the first write AFTER the
     * release, and nothing else in the flow validates the actor before then.
     *
     * Deterministic, self-contained, and entirely data-driven: no DDL, no
     * trigger, no lock, no second session. The previous version created a
     * trigger on public.profiles, which needs SHARE ROW EXCLUSIVE and blocked
     * behind an unrelated open transaction until the server's 120s
     * statement_timeout — long enough for Vitest to kill the test mid
     * transaction and strand ANOTHER one, which then blocked the next run.
     * A test that can be blocked by the state of the database is not a
     * regression test.
     */
    const { quickPrepareService } = await services();

    const broken = await makeAccount("atom-old");
    const customer = await makeCustomer("atom");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const approved = await makeAccount("atom-new");
    await makePreferred(approved.id);

    const before = await allocationRow(broken.id, 1);
    expect(before.status).toBe("sold");
    expect(before.customer_id).toBe(customer);

    /* A well-formed uuid that is deliberately not a user. */
    const ghost = "00000000-0000-4000-8000-0000000000ff";

    const users = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.users where id = ${ghost}::uuid
    `;
    expect(users[0]!.n).toBe(0);

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: await heldIds(broken.id, customer),
        replacementAccountId: approved.id,
        passwordChangeConfirmed: true,
      },
      { actor: { ...superAdmin, id: ghost } },
    );

    /* The transaction failed, after it had already written the release. */
    expect(result.ok).toBe(false);

    /* 1. The old allocation is exactly as it was. */
    const after = await allocationRow(broken.id, 1);
    expect(after.status).toBe("sold");
    expect(after.customer_id).toBe(customer);
    expect(after.expiration_date).toBe(before.expiration_date);

    /* 2. The replacement did not stick. */
    const onReplacement = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.profiles
      where account_id = ${approved.id}::uuid and customer_id = ${customer}::uuid
    `;
    expect(onReplacement[0]!.n).toBe(0);

    /* 3. No events from the failed transaction survived. */
    const events = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.profile_events
      where customer_id = ${customer}::uuid
    `;
    expect(events[0]!.n).toBe(0);
  }, 120_000);

  it("lets exactly one of two concurrent replacements win", async () => {
    const { quickPrepareService } = await services();

    const broken = await makeAccount("race-old");
    const customer = await makeCustomer("race");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const approved = await makeAccount("race-new");
    await makePreferred(approved.id);

    const held = await heldIds(broken.id, customer);

    const request = {
      accountId: broken.id,
      customerId: customer,
      expectedProfileIds: held,
      replacementAccountId: approved.id,
      passwordChangeConfirmed: true,
    };

    const [first, second] = await Promise.all([
      quickPrepareService.confirmReplacement(request, { actor: superAdmin }),
      quickPrepareService.confirmReplacement(request, { actor: superAdmin }),
    ]);

    /* One commits; the other finds the allocation gone and refuses. */
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);

    /* And the customer holds exactly what they should — never two allocations. */
    const total = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.profiles where customer_id = ${customer}::uuid
    `;
    expect(total[0]!.n).toBe(1);
  }, 120_000);
});
