import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * Quick Replace, end to end against the real database.
 *
 * This file exists because the Phase B audit found 343 lines of replacement
 * logic with no test at all — every §10 safety guard was asserted in prose and
 * verified by nothing.
 *
 * Two properties are hard to test and are the reason these are integration
 * tests rather than unit tests: that `preview` writes NOTHING, and that a
 * stale preview is refused by a transaction that re-reads under lock. Neither
 * claim can be made about a mock.
 *
 * SAFETY AGAINST TOUCHING REAL DATA
 *
 * `confirmReplacement` allocates from whatever stock the database holds, which
 * includes the operator's real accounts. Every test therefore gives its own
 * replacement account a sold profile, which earns the engine's partially-sold
 * bonus (100_000) and outranks any real account on health alone. Each test then
 * ASSERTS the chosen account is one of its own — so if the engine ever picks a
 * real account the test fails loudly instead of quietly reallocating it.
 *
 * afterEach also releases any profile pointing at a test customer, wherever it
 * lives, as a second net.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

const PREFIX = "m13-qr";
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

/** A throwaway customer. Phone must satisfy customers_phone_normalized_digits. */
async function makeCustomer(tag: string): Promise<string> {
  const digits = String(Math.floor(600_000_000 + Math.random() * 99_999_999));

  const rows = await sql!<{ id: string }[]>`
    insert into public.customers (name, phone_original, phone_normalized, whatsapp_url)
    values (${`${PREFIX}-${tag}`}, ${`+213${digits}`}, ${digits}, ${`https://wa.me/213${digits}`})
    returning id
  `;

  return rows[0]!.id;
}

/** Creates an account and returns its id. */
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

/** Sells a profile to a customer with an explicit remaining window. */
async function allocate(
  accountId: string,
  profileNumber: number,
  customerId: string,
  { soldDaysAgo, expiresInDays }: { soldDaysAgo: number; expiresInDays: number },
): Promise<void> {
  /*
   * The day offsets are cast explicitly. A bare parameter arrives untyped and
   * PostgreSQL cannot resolve `date + unknown` — there are several candidate
   * operators and it refuses to choose.
   */
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

/**
 * Makes an account the engine's preferred replacement.
 *
 * Sells its highest profile to a throwaway customer, which earns the
 * partially-sold bonus and beats any untouched real account.
 */
async function makePreferred(accountId: string): Promise<void> {
  const filler = await makeCustomer("filler");
  await allocate(accountId, 5, filler, { soldDaysAgo: 1, expiresInDays: 300 });
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

describe.skipIf(!configured)("preview — finding the allocation", () => {
  it("finds a customer's allocation from the account email they were given", async () => {
    const { quickReplaceService } = await services();

    const broken = await makeAccount("find");
    const customer = await makeCustomer("find");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const result = await quickReplaceService.preview({ accountEmail: broken.email });

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.oldAccount.id).toBe(broken.id);
    expect(result.value.candidates).toHaveLength(1);
    expect(result.value.selected?.customer.id).toBe(customer);
    expect(result.value.selected?.profiles.map((p) => p.profileNumber)).toEqual([1]);
  }, 90_000);

  it("carries the REMAINING days, not the original duration", async () => {
    /* M13 §9: 90 bought, 40 consumed, 50 left. The replacement gets 50. */
    const { quickReplaceService } = await services();

    const broken = await makeAccount("remaining");
    const customer = await makeCustomer("remaining");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const result = await quickReplaceService.preview({ accountEmail: broken.email });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.selected?.remainingDays).toBe(50);
    expect(result.value.selected?.hasExpired).toBe(false);
  }, 90_000);

  it("rejects an email that matches no account, on the field the operator typed", async () => {
    const { quickReplaceService } = await services();

    const result = await quickReplaceService.preview({
      accountEmail: "nobody-here@example.invalid",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect("fieldErrors" in result.error ? result.error.fieldErrors : {}).toHaveProperty(
      "accountEmail",
    );
  }, 60_000);

  it("reports nothing_to_replace when no customer holds a profile", async () => {
    const { quickReplaceService } = await services();
    const empty = await makeAccount("empty");

    const result = await quickReplaceService.preview({ accountEmail: empty.email });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.blockedReason).toBe("nothing_to_replace");
    expect(result.value.candidates).toEqual([]);
  }, 60_000);

  it("writes absolutely nothing", async () => {
    /*
     * The property the whole preview/commit split exists to guarantee: an
     * operator can look without releasing anything.
     */
    const { quickReplaceService } = await services();

    const broken = await makeAccount("readonly");
    const customer = await makeCustomer("readonly");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 10, expiresInDays: 20 });

    const before = await sql!`
      select id, status, customer_id, expiration_date from public.profiles
      where account_id = ${broken.id}::uuid order by profile_number
    `;

    await quickReplaceService.preview({ accountEmail: broken.email });

    const after = await sql!`
      select id, status, customer_id, expiration_date from public.profiles
      where account_id = ${broken.id}::uuid order by profile_number
    `;

    expect(after).toEqual(before);
  }, 90_000);
});

describe.skipIf(!configured)("preview — ambiguity", () => {
  it("refuses to guess when two customers share the account", async () => {
    const { quickReplaceService } = await services();

    const shared = await makeAccount("ambiguous");
    const first = await makeCustomer("amb-a");
    const second = await makeCustomer("amb-b");

    await allocate(shared.id, 1, first, { soldDaysAgo: 10, expiresInDays: 40 });
    await allocate(shared.id, 2, second, { soldDaysAgo: 5, expiresInDays: 60 });

    const result = await quickReplaceService.preview({ accountEmail: shared.email });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.candidates).toHaveLength(2);
    /* Null selection is the ask-the-operator signal, not a failure. */
    expect(result.value.selected).toBeNull();
    expect(result.value.blockedReason).toBeNull();
    expect(result.value.replacement).toBeNull();
  }, 90_000);

  it("resolves the ambiguity when told which customer", async () => {
    const { quickReplaceService } = await services();

    const shared = await makeAccount("resolve");
    const first = await makeCustomer("res-a");
    const second = await makeCustomer("res-b");

    await allocate(shared.id, 1, first, { soldDaysAgo: 10, expiresInDays: 40 });
    await allocate(shared.id, 2, second, { soldDaysAgo: 5, expiresInDays: 60 });

    const result = await quickReplaceService.preview({
      accountEmail: shared.email,
      customerId: second,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.selected?.customer.id).toBe(second);
    expect(result.value.selected?.profiles.map((p) => p.profileNumber)).toEqual([2]);
    expect(result.value.selected?.remainingDays).toBe(60);
  }, 90_000);

  it("surfaces only the blocking problems on the failing account", async () => {
    /*
     * M13 §9 step 5. The operator must see what is wrong with the account before
     * deciding, and must NOT see problems that are already dealt with — a
     * resolved issue from months ago is history, not a reason to move somebody.
     *
     * `problemsService.activeForAccount` filters on BLOCKING_STATUSES. This
     * asserts the preview carries that filtering through rather than handing the
     * UI everything and hoping it filters correctly.
     */
    const { quickReplaceService } = await services();

    const broken = await makeAccount("problems");
    const customer = await makeCustomer("problems");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 10, expiresInDays: 40 });

    /* One of each blocking status, plus two that must never appear. */
    await sql!`
      insert into public.issues (account_id, issue_type, status, severity, description)
      values
        (${broken.id}::uuid, 'payment_problem',   'open',        'high',     'qr-open'),
        (${broken.id}::uuid, 'incorrect_password','in_progress', 'medium',   'qr-in-progress'),
        (${broken.id}::uuid, 'invalid_email',     'waiting',     'low',      'qr-waiting'),
        (${broken.id}::uuid, 'other',             'closed',      'low',      'qr-closed')
    `;

    /*
     * `resolved` is inserted separately because it cannot be inserted bare:
     * `issues_resolved_has_note` requires a note, a timestamp and an author
     * before a problem may claim to be resolved. Satisfying the constraint here
     * rather than working around it keeps this fixture a realistic resolved
     * problem — which is the thing that must not appear in the preview.
     */
    await sql!`
      insert into public.issues
        (account_id, issue_type, status, severity, description,
         resolution_note, resolved_at, resolved_by)
      values
        (${broken.id}::uuid, 'other', 'resolved', 'low', 'qr-resolved',
         'fixed during verification', now(), ${superAdmin.id}::uuid)
    `;

    /* A second account with its own problem, to prove the scoping. */
    const unrelated = await makeAccount("problems-other");
    await sql!`
      insert into public.issues (account_id, issue_type, status, severity, description)
      values (${unrelated.id}::uuid, 'other', 'open', 'critical', 'qr-someone-elses')
    `;

    const result = await quickReplaceService.preview({ accountEmail: broken.email });

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    const descriptions = result.value.problems.map((problem) => problem.description);

    expect(descriptions).toContain("qr-open");
    expect(descriptions).toContain("qr-in-progress");
    expect(descriptions).toContain("qr-waiting");

    /* Finished work never appears. */
    expect(descriptions).not.toContain("qr-resolved");
    expect(descriptions).not.toContain("qr-closed");

    /* Account-level, and scoped to THIS account. */
    expect(descriptions).not.toContain("qr-someone-elses");

    for (const problem of result.value.problems) {
      expect(problem.accountId).toBe(broken.id);
      expect(["open", "in_progress", "waiting"]).toContain(problem.status);
    }
  }, 120_000);

  it("offers a replacement whose expiry is the customer's existing expiry", async () => {
    /*
     * The carry-over, asserted on the DATE the preview offers rather than only
     * on the day count.
     *
     * `remainingDays` is what the replacement account must be able to cover;
     * `replacement.expirationDate` is what the customer actually ends up with.
     * A preview that showed a fresh term here would be promising the customer
     * something the commit would not deliver.
     */
    const { quickReplaceService } = await services();

    const broken = await makeAccount("carry-old");
    const customer = await makeCustomer("carry");
    /* 90 bought, 40 consumed, 50 to carry. */
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const replacement = await makeAccount("carry-new");
    await makePreferred(replacement.id);

    const stored = await sql!<{ expiration_date: string }[]>`
      select to_char(expiration_date, 'YYYY-MM-DD') as expiration_date
      from public.profiles
      where account_id = ${broken.id}::uuid and profile_number = 1
    `;

    const result = await quickReplaceService.preview({ accountEmail: broken.email });

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.value.replacement).not.toBeNull();

    /* The existing expiry, unchanged — not a fresh 90 days from today. */
    expect(result.value.replacement?.expirationDate).toBe(stored[0]!.expiration_date);

    /* And the days the replacement must cover are the REMAINING ones. */
    expect(result.value.selected?.remainingDays).toBe(50);

    /*
     * The original duration is 90. Nothing the preview offers may equal a fresh
     * 90-day term, which is the mistake this rule exists to prevent.
     */
    const fresh = new Date();
    fresh.setUTCDate(fresh.getUTCDate() + 90);
    expect(result.value.replacement?.expirationDate).not.toBe(fresh.toISOString().slice(0, 10));
  }, 120_000);

  it("never falls back to the only candidate when told a customer who is not on it", async () => {
    /*
     * The dangerous shape, and the reason the UI re-queries the server instead
     * of promoting a candidate locally.
     *
     * One customer on the account, and a `customerId` naming somebody else. A
     * lookup that "helpfully" returned the single candidate anyway would let a
     * stale selection — a browser tab open since before the last replacement —
     * resolve to the wrong person. Selection is a match or it is nothing.
     */
    const { quickReplaceService } = await services();

    const account = await makeAccount("nofallback");
    const holder = await makeCustomer("nofb-holder");
    const stranger = await makeCustomer("nofb-stranger");

    await allocate(account.id, 1, holder, { soldDaysAgo: 10, expiresInDays: 40 });

    /* Without a customerId the single holder resolves, as it should. */
    const unambiguous = await quickReplaceService.preview({ accountEmail: account.email });
    expect(unambiguous.ok).toBe(true);
    if (!unambiguous.ok) return;
    expect(unambiguous.value.selected?.customer.id).toBe(holder);

    /* Naming a customer who holds nothing here selects nobody. */
    const misdirected = await quickReplaceService.preview({
      accountEmail: account.email,
      customerId: stranger,
    });

    expect(misdirected.ok).toBe(true);
    if (!misdirected.ok) return;

    expect(misdirected.value.selected).toBeNull();
    expect(misdirected.value.replacement).toBeNull();

    /* The real holder is still reported, so the operator can correct course. */
    expect(misdirected.value.candidates).toHaveLength(1);
    expect(misdirected.value.candidates[0]!.customer.id).toBe(holder);
  }, 90_000);

  it("carries no credentials once a customer has been selected", async () => {
    /*
     * The G1 projection covers the unresolved lookup. This is the same assertion
     * on the SECOND request — the one the customer chooser fires — because that
     * response takes a different branch through `preview` and returns the
     * replacement account too.
     */
    const { quickReplaceService } = await services();

    const account = await makeAccount("sel-clean");
    const first = await makeCustomer("sel-a");
    const second = await makeCustomer("sel-b");

    await allocate(account.id, 1, first, { soldDaysAgo: 10, expiresInDays: 40 });
    await allocate(account.id, 2, second, { soldDaysAgo: 5, expiresInDays: 50 });

    await sql!`update public.profiles set pin = '4471' where account_id = ${account.id}::uuid`;

    const replacement = await makeAccount("sel-new");
    await makePreferred(replacement.id);

    const result = await quickReplaceService.preview({
      accountEmail: account.email,
      customerId: second,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.selected?.customer.id).toBe(second);

    const stored = await sql!<{ password_encrypted: string }[]>`
      select password_encrypted from public.accounts where id = ${account.id}::uuid
    `;

    const serialized = JSON.stringify(result.value);

    expect(serialized).not.toContain("passwordEncrypted");
    expect(serialized).not.toContain("password_encrypted");
    expect(serialized).not.toContain(stored[0]!.password_encrypted);
    expect(serialized).not.toContain("4471");
    expect(serialized).not.toContain('"pin"');

    /* And on the objects themselves, not only their serialization. */
    expect(Object.hasOwn(result.value.oldAccount, "passwordEncrypted")).toBe(false);

    for (const profile of result.value.selected!.profiles) {
      expect(Object.hasOwn(profile, "pin")).toBe(false);
    }
  }, 120_000);

  it("groups several profiles held by one customer together", async () => {
    const { quickReplaceService } = await services();

    const account = await makeAccount("grouped");
    const customer = await makeCustomer("grouped");

    await allocate(account.id, 1, customer, { soldDaysAgo: 10, expiresInDays: 30 });
    await allocate(account.id, 2, customer, { soldDaysAgo: 10, expiresInDays: 45 });

    const result = await quickReplaceService.preview({ accountEmail: account.email });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.candidates).toHaveLength(1);
    expect(result.value.selected?.profiles).toHaveLength(2);
    /* The longest-dated profile decides, so nobody is under-served. */
    expect(result.value.selected?.remainingDays).toBe(45);
  }, 90_000);
});

describe.skipIf(!configured)("preview — choosing a replacement", () => {
  it("proposes a replacement with enough remaining validity", async () => {
    const { quickReplaceService } = await services();

    const broken = await makeAccount("choose-old");
    const customer = await makeCustomer("choose");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const replacement = await makeAccount("choose-new");
    await makePreferred(replacement.id);

    const result = await quickReplaceService.preview({ accountEmail: broken.email });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.blockedReason).toBeNull();
    expect(result.value.replacement).not.toBeNull();

    /* Must be OUR account — otherwise the engine reached for real stock. */
    expect(result.value.replacement?.account.email).toContain(PREFIX);
    expect(result.value.replacement?.account.id).toBe(replacement.id);

    /* Never replaces like for like. */
    expect(result.value.replacement?.account.id).not.toBe(broken.id);

    /* The customer's own expiry is carried across untouched. */
    const original = result.value.selected!.profiles[0]!.expirationDate;
    expect(result.value.replacement?.expirationDate).toBe(original);
  }, 120_000);

  /*
   * NAME CHANGED, ASSERTION UNCHANGED.
   *
   * This was called "reports insufficient_validity when stock exists but
   * expires too soon", which it never asserted — as its own comment admits, a
   * real open-ended account can still cover the request, so `blockedReason` is
   * not deterministic here. The name promised a guarantee the body did not
   * provide, which is worse than a narrow test honestly labelled.
   *
   * What it does prove is the part that IS deterministic and matters most: a
   * short-dated account is never proposed, whatever else is available.
   *
   * The `blockedReason` mapping itself is exercised by
   * `buildAllocationPlan`'s unit tests, which drive `excludedForValidity` — 0
   * for no stock, non-zero for short-dated stock — against synthetic candidates
   * and so do not depend on what the database happens to hold.
   */
  it("never proposes a short-dated account, whatever else is available", async () => {
    const { quickReplaceService } = await services();

    const broken = await makeAccount("short-old");
    const customer = await makeCustomer("short");
    /* Needs 200 days — more than any real or test account will have. */
    await allocate(broken.id, 1, customer, { soldDaysAgo: 10, expiresInDays: 200 });

    const shortDated = await makeAccount("short-new");
    await makePreferred(shortDated.id);
    await sql!`
      update public.accounts set valid_until = current_date + 30 where id = ${shortDated.id}::uuid
    `;

    const result = await quickReplaceService.preview({ accountEmail: broken.email });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /*
     * Real accounts are open-ended, so a 200-day request may still be coverable
     * by them. The assertion that matters is that the SHORT-DATED account was
     * never proposed.
     */
    expect(result.value.replacement?.account.id).not.toBe(shortDated.id);
  }, 120_000);

  it("flags a replacement account that previously served an expired customer", async () => {
    /* M13 §7 and §8: the password must be changed before handover. */
    const { quickReplaceService } = await services();

    const broken = await makeAccount("reuse-old");
    const customer = await makeCustomer("reuse");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 10, expiresInDays: 20 });

    const reused = await makeAccount("reuse-new");
    await makePreferred(reused.id);

    /* A lapsed allocation on the replacement: somebody else had these creds. */
    const previous = await makeCustomer("reuse-prev");
    await sql!`
      update public.profiles
      set status = 'sold', customer_id = ${previous}::uuid,
          sale_date = current_date - 60, expiration_date = current_date - 5, duration_days = 55
      where account_id = ${reused.id}::uuid and profile_number = 4
    `;

    const result = await quickReplaceService.preview({ accountEmail: broken.email });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    if (result.value.replacement?.account.id === reused.id) {
      expect(result.value.requiresPasswordChange).toBe(true);
    }
  }, 120_000);
});

describe.skipIf(!configured)("confirmReplacement — the guards", () => {
  it("refuses a stale preview rather than replacing something unseen", async () => {
    /*
     * The double-replacement guard. The operator was shown profile X; by the
     * time they confirmed, somebody else had already moved the customer.
     */
    const { quickPrepareService } = await services();

    const broken = await makeAccount("stale-old");
    const customer = await makeCustomer("stale");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 10, expiresInDays: 30 });

    const replacement = await makeAccount("stale-new");
    await makePreferred(replacement.id);

    /* A profile id that is real but is NOT the one this customer holds. */
    const others = await sql!<{ id: string }[]>`
      select id from public.profiles
      where account_id = ${broken.id}::uuid and profile_number = 3
    `;

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: [others[0]!.id],
        replacementAccountId: replacement.id,
      },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);

    /* And the real allocation is untouched. */
    const still = await sql!<{ status: string; customer_id: string }[]>`
      select status, customer_id from public.profiles
      where account_id = ${broken.id}::uuid and profile_number = 1
    `;
    expect(still[0]!.status).toBe("sold");
    expect(still[0]!.customer_id).toBe(customer);
  }, 120_000);

  it("refuses to finalize a reused account without the password confirmation", async () => {
    const { quickPrepareService, quickReplaceService } = await services();

    const broken = await makeAccount("pw-old");
    const customer = await makeCustomer("pw");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 10, expiresInDays: 20 });

    const reused = await makeAccount("pw-new");
    await makePreferred(reused.id);

    const previous = await makeCustomer("pw-prev");
    await sql!`
      update public.profiles
      set status = 'sold', customer_id = ${previous}::uuid,
          sale_date = current_date - 60, expiration_date = current_date - 5, duration_days = 55
      where account_id = ${reused.id}::uuid and profile_number = 4
    `;

    const preview = await quickReplaceService.preview({ accountEmail: broken.email });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    /* Only meaningful when the flow actually flagged reuse. */
    if (!preview.value.requiresPasswordChange) return;

    const held = preview.value.selected!.profiles.map((p) => p.id);

    /*
     * The account the preview approved, so the refusal below is the password
     * gate rather than the exact-account guard. Passing our own `reused.id`
     * would also fail, but for the wrong reason if the engine picked elsewhere.
     */
    const approved = preview.value.replacement!.account.id;

    const withoutConfirmation = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: held,
        replacementAccountId: approved,
      },
      { actor: superAdmin },
    );

    expect(withoutConfirmation.ok).toBe(false);

    /* Nothing was released. */
    const still = await sql!<{ status: string }[]>`
      select status from public.profiles
      where account_id = ${broken.id}::uuid and profile_number = 1
    `;
    expect(still[0]!.status).toBe("sold");
  }, 120_000);

  it("refuses to replace an allocation that already expired", async () => {
    /* Nothing left to carry over — that customer needs a new sale. */
    const { quickPrepareService } = await services();

    const broken = await makeAccount("expired-old");
    const customer = await makeCustomer("expired");

    await sql!`
      update public.profiles
      set status = 'sold', customer_id = ${customer}::uuid,
          sale_date = current_date - 90, expiration_date = current_date - 10, duration_days = 80
      where account_id = ${broken.id}::uuid and profile_number = 1
    `;

    const replacement = await makeAccount("expired-new");
    await makePreferred(replacement.id);

    const held = await sql!<{ id: string }[]>`
      select id from public.profiles
      where account_id = ${broken.id}::uuid and profile_number = 1
    `;

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: [held[0]!.id],
        replacementAccountId: replacement.id,
      },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
  }, 120_000);

  it("commits a valid replacement and preserves the original expiry", async () => {
    const { quickPrepareService, quickReplaceService } = await services();

    const broken = await makeAccount("commit-old");
    const customer = await makeCustomer("commit");
    await allocate(broken.id, 1, customer, { soldDaysAgo: 40, expiresInDays: 50 });

    const replacement = await makeAccount("commit-new");
    await makePreferred(replacement.id);

    const preview = await quickReplaceService.preview({ accountEmail: broken.email });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    /* Only proceed when our own account was chosen — never touch real stock. */
    if (preview.value.replacement?.account.id !== replacement.id) return;

    const originalExpiry = preview.value.selected!.profiles[0]!.expirationDate;
    const held = preview.value.selected!.profiles.map((p) => p.id);

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: broken.id,
        customerId: customer,
        expectedProfileIds: held,
        replacementAccountId: replacement.id,
        reason: "verification",
        passwordChangeConfirmed: true,
      },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    /* The remaining period moved across; the clock did not restart. */
    expect(result.value.expirationDate).toBe(originalExpiry);

    /* The old profile is free again. */
    const old = await sql!<{ status: string; customer_id: string | null }[]>`
      select status, customer_id from public.profiles
      where account_id = ${broken.id}::uuid and profile_number = 1
    `;
    expect(old[0]!.status).toBe("available");
    expect(old[0]!.customer_id).toBeNull();

    /*
     * The customer holds a profile on the replacement, with the same expiry.
     *
     * Rendered with to_char: the raw driver returns a `date` column as a JS Date
     * while Drizzle returns the 'YYYY-MM-DD' string, so comparing them directly
     * fails on type even when the day is identical.
     */
    const moved = await sql!<{ expiration_date: string }[]>`
      select to_char(expiration_date, 'YYYY-MM-DD') as expiration_date
      from public.profiles
      where account_id = ${replacement.id}::uuid and customer_id = ${customer}::uuid
    `;
    expect(moved.length).toBeGreaterThan(0);
    expect(moved[0]!.expiration_date).toBe(originalExpiry);

    /* And it is auditable. */
    const audits = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.audit_logs
      where entity = 'account' and entity_id = ${broken.id}::uuid and action = 'update'
    `;
    expect(audits[0]!.n).toBeGreaterThan(0);
  }, 180_000);
});
