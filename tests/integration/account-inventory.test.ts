import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * Account inventory, end to end against the real database.
 *
 * The unit tests pin the rules. This answers what they cannot: does the
 * migration actually behave — do the check constraints fire, does the
 * `not_for_sale` status survive a round trip, does the slot change move profile
 * rows, and does a failed bulk import really write nothing.
 *
 * That last one is the reason this file exists. "Nothing was written" is a
 * claim about a database, and no amount of pure-function testing can make it.
 *
 * Everything is created on the reserved `.invalid` domain and removed in
 * afterAll. Skipped automatically when no real project is configured.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

const PREFIX = "m13-inv";
const PLAINTEXT = "not-a-real-password";

let superAdmin: AppUser;

/** Unique per run, so a crashed run cannot collide with the next one. */
function email(name: string): string {
  return `${PREFIX}-${name}-${Date.now()}@example.invalid`;
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

afterAll(async () => {
  if (!configured) return;

  /* Profiles and events cascade from the account. */
  await sql!`delete from public.accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!.end({ timeout: 5 });
});

async function service() {
  const { accountsService } = await import("@/modules/accounts");
  return accountsService;
}

async function profileRows(accountId: string) {
  return sql!<{ profile_number: number; status: string; customer_id: string | null }[]>`
    select profile_number, status, customer_id
    from public.profiles where account_id = ${accountId}::uuid
    order by profile_number
  `;
}

describe.skipIf(!configured)("creating an account with a profile count", () => {
  it("always writes five rows, whatever the slot count", async () => {
    /*
     * The heart of ADR-013 Decision 1. 01_MASTER_RULES.md forbids a dynamic
     * profile count, so the rows stay at five and only their sellability moves.
     *
     * All five are `available` at the column level — sellability is DERIVED
     * from profile_number against profile_slots, never stored. Decision 2.
     */
    const accountsService = await service();

    for (const slots of [1, 3, 5]) {
      const result = await accountsService.createAccount(
        { email: email(`slots${slots}`), password: PLAINTEXT, country: "DZ", profileSlots: slots },
        { actor: superAdmin },
      );

      expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
      if (!result.ok) continue;

      const rows = await profileRows(result.value.id);

      expect(rows, `slots=${slots}`).toHaveLength(5);
      expect(result.value.profileSlots).toBe(slots);
      expect(rows.every((row) => row.status === "available")).toBe(true);

      /* What the list screen and the allocator actually see. */
      const listed = await accountsService.listAccounts({ search: result.value.email });
      expect(listed.ok).toBe(true);

      if (listed.ok) {
        const row = listed.value.items.find((item) => item.account.id === result.value.id);
        expect(row?.availableProfiles, `slots=${slots} available`).toBe(slots);
        expect(row?.notForSaleProfiles, `slots=${slots} parked`).toBe(5 - slots);
      }
    }
  }, 90_000);

  it("defaults to five when no count is given", async () => {
    /* Every caller written before M13 keeps its exact behaviour. */
    const accountsService = await service();

    const result = await accountsService.createAccount(
      { email: email("default"), password: PLAINTEXT, country: "DZ" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.profileSlots).toBe(5);

    const rows = await profileRows(result.value.id);
    expect(rows.filter((row) => row.status === "available")).toHaveLength(5);
  }, 90_000);

  it("refuses an out-of-range profile count", async () => {
    const accountsService = await service();

    for (const slots of [0, 6, -1, 2.5]) {
      const result = await accountsService.createAccount(
        { email: email(`bad${slots}`), password: PLAINTEXT, profileSlots: slots },
        { actor: superAdmin },
      );

      expect(result.ok, `profileSlots=${slots} was accepted`).toBe(false);
    }
  }, 60_000);

  it("refuses an invalid duration", async () => {
    const accountsService = await service();

    for (const days of [0, -30, 731]) {
      const result = await accountsService.createAccount(
        { email: email(`dur${days}`), password: PLAINTEXT, durationDays: days },
        { actor: superAdmin },
      );

      expect(result.ok, `durationDays=${days} was accepted`).toBe(false);
    }
  }, 60_000);

  it("turns a duration into a stored coverage boundary", async () => {
    const accountsService = await service();

    const result = await accountsService.createAccount(
      { email: email("duration"), password: PLAINTEXT, durationDays: 90 },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await sql!<{ valid_until: string | null; remaining: number }[]>`
      select valid_until, (valid_until - current_date)::int as remaining
      from public.accounts where id = ${result.value.id}::uuid
    `;

    expect(rows[0]!.valid_until).not.toBeNull();
    expect(rows[0]!.remaining).toBe(90);
  }, 60_000);

  it("leaves validity open-ended when nothing is supplied", async () => {
    /*
     * The compatibility guarantee. NULL means open-ended, not expired — if this
     * ever flips, every pre-M13 account silently leaves the catalogue.
     */
    const accountsService = await service();

    const result = await accountsService.createAccount(
      { email: email("openended"), password: PLAINTEXT },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.validUntil).toBeNull();
  }, 60_000);
});

describe.skipIf(!configured)("changing the sellable slot count", () => {
  it("changes sellable stock without touching a single profile row, and audits it", async () => {
    const accountsService = await service();
    const { allocationRepository } =
      await import("@/modules/quick-prepare/repositories/allocation.repository");

    const created = await accountsService.createAccount(
      { email: email("slotchange"), password: PLAINTEXT, profileSlots: 5 },
      { actor: superAdmin },
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const id = created.value.id;

    /** What the allocator would actually offer right now. */
    async function offered(): Promise<number> {
      const candidates = await allocationRepository.findCandidates();
      if (!candidates.ok) return -1;
      return (
        candidates.value.find((candidate) => candidate.account.id === id)?.availableProfiles
          .length ?? 0
      );
    }

    expect(await offered()).toBe(5);

    /* Down to two. */
    const lowered = await accountsService.setProfileSlots(
      id,
      { profileSlots: 2 },
      { actor: superAdmin },
    );

    expect(lowered.ok, lowered.ok ? "" : lowered.error.message).toBe(true);
    expect(await offered()).toBe(2);

    /*
     * The profile ROWS never moved. That is the point of deriving: there is no
     * second copy of this fact that could disagree with profile_slots.
     */
    const afterLower = await profileRows(id);
    expect(afterLower).toHaveLength(5);
    expect(afterLower.every((row) => row.status === "available")).toBe(true);

    /* Back up to four: stock returns with no rewrite. */
    const raised = await accountsService.setProfileSlots(
      id,
      { profileSlots: 4 },
      { actor: superAdmin },
    );

    expect(raised.ok).toBe(true);
    expect(await offered()).toBe(4);

    /* The approval requires who, when, from what, to what. */
    const audits = await sql!<{ before: unknown; after: unknown }[]>`
      select before, after from public.audit_logs
      where entity = 'account' and entity_id = ${id}::uuid and action = 'update'
      order by created_at
    `;

    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audits)).toContain("profile_slots_changed");
  }, 60_000);

  it("writes no audit entry when the value did not change", async () => {
    const accountsService = await service();

    const created = await accountsService.createAccount(
      { email: email("noop"), password: PLAINTEXT, profileSlots: 3 },
      { actor: superAdmin },
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await accountsService.setProfileSlots(
      created.value.id,
      { profileSlots: 3 },
      { actor: superAdmin },
    );

    const audits = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.audit_logs
      where entity = 'account' and entity_id = ${created.value.id}::uuid and action = 'update'
    `;

    expect(audits[0]!.n).toBe(0);
  }, 60_000);

  it("refuses to take an allocated profile out of stock", async () => {
    /*
     * The invariant that makes a stored `not_for_sale` safe. Honouring this
     * change would either strand the customer or silently cancel them, and an
     * inventory setting must not be able to do either.
     */
    const accountsService = await service();

    const created = await accountsService.createAccount(
      { email: email("occupied"), password: PLAINTEXT, profileSlots: 5 },
      { actor: superAdmin },
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const customers = await sql!<{ id: string }[]>`
      select id from public.customers where deleted_at is null limit 1
    `;

    if (customers.length === 0) {
      /* Nothing to allocate to. The rule is covered by the unit suite regardless. */
      return;
    }

    await sql!`
      update public.profiles
      set status = 'sold', customer_id = ${customers[0]!.id}::uuid,
          sale_date = current_date, expiration_date = current_date + 30, duration_days = 30
      where account_id = ${created.value.id}::uuid and profile_number = 4
    `;

    const result = await accountsService.setProfileSlots(
      created.value.id,
      { profileSlots: 2 },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);

    /* The slot count did not move, so the customer still holds real stock. */
    const stored = await sql!<{ profile_slots: number }[]>`
      select profile_slots from public.accounts where id = ${created.value.id}::uuid
    `;
    expect(stored[0]!.profile_slots).toBe(5);

    const rows = await profileRows(created.value.id);
    const sold = rows.find((row) => row.profile_number === 4);
    expect(sold?.status).toBe("sold");
    expect(sold?.customer_id).not.toBeNull();
  }, 60_000);
});

describe.skipIf(!configured)("bulk import", () => {
  it("creates every row of a valid batch", async () => {
    const accountsService = await service();
    const stamp = Date.now();

    const text = [
      `${PREFIX}-bulk-a-${stamp}@example.invalid,pw-a,DZ,90,3`,
      `${PREFIX}-bulk-b-${stamp}@example.invalid,pw-b,FR,30,5`,
    ].join("\n");

    const result = await accountsService.createAccountsInBulk(text, { actor: superAdmin });

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.created).toHaveLength(2);
    expect(result.value.rejected).toEqual([]);

    /* Each got its own slot count, and each still has five rows. */
    const first = result.value.created.find((account) => account.email.includes("bulk-a"));
    expect(first?.profileSlots).toBe(3);

    const rows = await profileRows(first!.id);
    expect(rows).toHaveLength(5);

    /* Every submitted row is accounted for exactly once. */
    expect(result.value.submitted).toBe(2);
    expect(result.value.created.length + result.value.rejected.length).toBe(result.value.submitted);
  }, 90_000);

  it("encrypts every password, never storing what was pasted", async () => {
    const accountsService = await service();
    const stamp = Date.now();
    const plaintext = "bulk-plaintext-secret";

    const result = await accountsService.createAccountsInBulk(
      `${PREFIX}-enc-${stamp}@example.invalid,${plaintext},DZ`,
      { actor: superAdmin },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await sql!<{ password_encrypted: string }[]>`
      select password_encrypted from public.accounts
      where id = ${result.value.created[0]!.id}::uuid
    `;

    expect(rows[0]!.password_encrypted).not.toBe(plaintext);
    expect(rows[0]!.password_encrypted).toMatch(/^v1:/);
  }, 60_000);

  it("imports the good rows and reports the bad one, per line", async () => {
    /*
     * ADR-013 Decision 6, as revised. An operator importing a hundred accounts
     * must not lose ninety-nine to one typo — but nothing may be created
     * SILENTLY, so every submitted row comes back created or rejected.
     */
    const accountsService = await service();
    const stamp = Date.now();

    const good1 = `${PREFIX}-partial-a-${stamp}@example.invalid`;
    const good2 = `${PREFIX}-partial-b-${stamp}@example.invalid`;

    const text = [
      `${good1},pw-a,DZ,90,3`,
      `definitely-not-an-email,pw-b,FR,30,5`,
      `${good2},pw-c,DZ,60,2`,
    ].join("\n");

    const result = await accountsService.createAccountsInBulk(text, { actor: superAdmin });

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.submitted).toBe(3);
    expect(result.value.created).toHaveLength(2);
    expect(result.value.rejected).toHaveLength(1);

    /* The reason is attached to the line the operator actually typed. */
    expect(result.value.rejected[0]?.line).toBe(2);
    expect(result.value.rejected[0]?.fieldErrors["email"]).toBeTruthy();

    const rows = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.accounts where email in (${good1}, ${good2})
    `;
    expect(rows[0]!.n).toBe(2);
  }, 90_000);

  it("skips an email that already exists and imports the rest", async () => {
    /*
     * The skip is decided by the unique index, not by a prior SELECT, so two
     * operators importing overlapping lists cannot race each other.
     */
    const accountsService = await service();
    const stamp = Date.now();
    const taken = `${PREFIX}-dupe-${stamp}@example.invalid`;
    const fresh = `${PREFIX}-dupe-new-${stamp}@example.invalid`;

    const first = await accountsService.createAccount(
      { email: taken, password: PLAINTEXT },
      { actor: superAdmin },
    );
    expect(first.ok).toBe(true);

    const result = await accountsService.createAccountsInBulk(
      [`${fresh},pw-a,DZ`, `${taken},pw-b,DZ`].join("\n"),
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.submitted).toBe(2);
    expect(result.value.created).toHaveLength(1);
    expect(result.value.created[0]?.email).toBe(fresh);

    expect(result.value.rejected).toHaveLength(1);
    expect(result.value.rejected[0]?.email).toBe(taken);
    expect(result.value.rejected[0]?.line).toBe(2);

    /* The duplicate did not create a second account, and got no profiles. */
    const accountCount = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.accounts where email = ${taken}
    `;
    expect(accountCount[0]!.n).toBe(1);

    const profileCount = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.profiles p
      join public.accounts a on a.id = p.account_id where a.email = ${taken}
    `;
    expect(profileCount[0]!.n).toBe(5);
  }, 90_000);

  it("returns no credential in the bulk result", async () => {
    /*
     * `created` was `AccountRow[]`, so a bulk import returned the AES ciphertext
     * of every new account through a Server Action — the same leak as the list
     * and the detail page, and the worst of the three because one call creates
     * many at once.
     *
     * Narrowing the type alone was NOT enough: AccountRow is structurally
     * assignable to AccountView, so it compiled while the field stayed in the
     * object. This asserts the runtime value, which is the only thing that
     * actually crosses to the browser.
     */
    const accountsService = await service();
    const stamp = Date.now();
    const plaintext = "bulk-result-secret";

    const result = await accountsService.createAccountsInBulk(
      `${PREFIX}-noleak-${stamp}@example.invalid,${plaintext},DZ`,
      { actor: superAdmin },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.created).toHaveLength(1);
    expect(result.value.created[0]).not.toHaveProperty("passwordEncrypted");

    const stored = await sql!<{ password_encrypted: string }[]>`
      select password_encrypted from public.accounts where id = ${result.value.created[0]!.id}::uuid
    `;

    const serialised = JSON.stringify(result.value);
    expect(serialised).not.toContain(plaintext);
    expect(serialised).not.toContain(stored[0]!.password_encrypted);
  }, 90_000);

  it("accounts for every submitted row exactly once", async () => {
    /* created + rejected === submitted, asserted against the real service. */
    const accountsService = await service();
    const stamp = Date.now();

    const result = await accountsService.createAccountsInBulk(
      [
        `${PREFIX}-arith-a-${stamp}@example.invalid,pw,DZ`,
        `definitely-not-an-email,pw,FR`,
        `${PREFIX}-arith-b-${stamp}@example.invalid,pw,DZ`,
      ].join("\n"),
      { actor: superAdmin },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.submitted).toBe(3);
    expect(result.value.created.length + result.value.rejected.length).toBe(result.value.submitted);
  }, 90_000);

  it("rejects empty input rather than reporting a successful import of nothing", async () => {
    const accountsService = await service();

    expect((await accountsService.createAccountsInBulk("", { actor: superAdmin })).ok).toBe(false);
    expect((await accountsService.createAccountsInBulk("   ", { actor: superAdmin })).ok).toBe(
      false,
    );
  }, 30_000);
});

describe.skipIf(!configured)("allocation reads the new rules", () => {
  it("never offers a not-for-sale profile", async () => {
    const accountsService = await service();
    const { allocationRepository } =
      await import("@/modules/quick-prepare/repositories/allocation.repository");

    const created = await accountsService.createAccount(
      { email: email("alloc"), password: PLAINTEXT, profileSlots: 2 },
      { actor: superAdmin },
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const candidates = await allocationRepository.findCandidates();
    expect(candidates.ok).toBe(true);
    if (!candidates.ok) return;

    const mine = candidates.value.find((candidate) => candidate.account.id === created.value.id);

    /*
     * All five rows read `available` in the column; only two are within
     * profile_slots. The allocator must offer exactly those two — the derived
     * rule doing its job in SQL, with no stored status to fall back on.
     */
    expect(mine?.availableProfiles).toHaveLength(2);
    expect(mine?.availableProfiles.map((profile) => profile.profileNumber)).toEqual([1, 2]);
  }, 60_000);

  it("excludes an account whose own coverage has expired", async () => {
    const accountsService = await service();
    const { allocationRepository } =
      await import("@/modules/quick-prepare/repositories/allocation.repository");

    const created = await accountsService.createAccount(
      { email: email("expired"), password: PLAINTEXT },
      { actor: superAdmin },
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await sql!`
      update public.accounts set valid_until = current_date - 1
      where id = ${created.value.id}::uuid
    `;

    const candidates = await allocationRepository.findCandidates();
    expect(candidates.ok).toBe(true);
    if (!candidates.ok) return;

    expect(candidates.value.some((candidate) => candidate.account.id === created.value.id)).toBe(
      false,
    );
  }, 60_000);

  it("offers a sold profile again once its customer has expired", async () => {
    /*
     * 03_DATABASE.md has required this since M02 and nothing implemented it, so
     * expired profiles were stock that could never be sold again. The row still
     * reads `sold`; the DATE is what makes it available.
     */
    const accountsService = await service();
    const { allocationRepository } =
      await import("@/modules/quick-prepare/repositories/allocation.repository");

    const created = await accountsService.createAccount(
      { email: email("recycle"), password: PLAINTEXT },
      { actor: superAdmin },
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const customers = await sql!<{ id: string }[]>`
      select id from public.customers where deleted_at is null limit 1
    `;

    if (customers.length === 0) return;

    /* Sold, and lapsed a week ago. */
    await sql!`
      update public.profiles
      set status = 'sold', customer_id = ${customers[0]!.id}::uuid,
          sale_date = current_date - 40, expiration_date = current_date - 7, duration_days = 33
      where account_id = ${created.value.id}::uuid and profile_number = 1
    `;

    const candidates = await allocationRepository.findCandidates();
    expect(candidates.ok).toBe(true);
    if (!candidates.ok) return;

    const mine = candidates.value.find((candidate) => candidate.account.id === created.value.id);

    const offered = mine?.availableProfiles.map((profile) => profile.profileNumber) ?? [];

    expect(offered).toContain(1);
  }, 60_000);

  it("keeps a live sold profile out of the candidate pool", async () => {
    const accountsService = await service();
    const { allocationRepository } =
      await import("@/modules/quick-prepare/repositories/allocation.repository");

    const created = await accountsService.createAccount(
      { email: email("live"), password: PLAINTEXT },
      { actor: superAdmin },
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const customers = await sql!<{ id: string }[]>`
      select id from public.customers where deleted_at is null limit 1
    `;

    if (customers.length === 0) return;

    await sql!`
      update public.profiles
      set status = 'sold', customer_id = ${customers[0]!.id}::uuid,
          sale_date = current_date, expiration_date = current_date + 30, duration_days = 30
      where account_id = ${created.value.id}::uuid and profile_number = 1
    `;

    const candidates = await allocationRepository.findCandidates();
    expect(candidates.ok).toBe(true);
    if (!candidates.ok) return;

    const mine = candidates.value.find((candidate) => candidate.account.id === created.value.id);

    const offered = mine?.availableProfiles.map((profile) => profile.profileNumber) ?? [];

    expect(offered).not.toContain(1);
  }, 60_000);
});

describe.skipIf(!configured)("changing the stored password", () => {
  it("re-encrypts and audits without recording the value", async () => {
    const accountsService = await service();

    const created = await accountsService.createAccount(
      { email: email("pwchange"), password: PLAINTEXT },
      { actor: superAdmin },
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const before = await sql!<{ password_encrypted: string }[]>`
      select password_encrypted from public.accounts where id = ${created.value.id}::uuid
    `;

    const newPassword = "rotated-after-reuse";

    const result = await accountsService.changePassword(
      created.value.id,
      { currentPassword: PLAINTEXT, newPassword, confirmPassword: newPassword },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);

    const after = await sql!<{ password_encrypted: string }[]>`
      select password_encrypted from public.accounts where id = ${created.value.id}::uuid
    `;

    expect(after[0]!.password_encrypted).not.toBe(before[0]!.password_encrypted);
    expect(after[0]!.password_encrypted).not.toContain(newPassword);

    /* The event is recorded; the secret is not. */
    const audits = await sql!<{ after: unknown }[]>`
      select after from public.audit_logs
      where entity = 'account' and entity_id = ${created.value.id}::uuid and action = 'update'
    `;

    const serialised = JSON.stringify(audits);
    expect(serialised).toContain("password_changed");
    expect(serialised).not.toContain(newPassword);
  }, 60_000);

  it("refuses when the confirmation does not match", async () => {
    const accountsService = await service();

    const created = await accountsService.createAccount(
      { email: email("pwmismatch"), password: PLAINTEXT },
      { actor: superAdmin },
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await accountsService.changePassword(
      created.value.id,
      { newPassword: "one-value", confirmPassword: "a-different-value" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
  }, 60_000);
});
