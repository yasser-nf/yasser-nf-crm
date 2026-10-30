import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M09C — Change Suggested Account.
 *
 * What these tests pin down:
 *
 *   - an alternative comes from the SAME engine under the SAME rules, with the
 *     turned-down accounts removed — never from a looser search;
 *   - nothing is reserved by suggesting, so turning a suggestion down has
 *     nothing to release and blacklists nothing beyond the request;
 *   - confirmation sells exactly the reviewed account(s) or refuses — it never
 *     substitutes, and a stale review cannot be confirmed;
 *   - idempotency tells a retry of one order from a new order for another
 *     account.
 *
 * STOCK IS CONTROLLED, NOT HOPED FOR. Every other suite has to coexist with the
 * seed's stock and asserts "if the engine picked ours". This one needs to know
 * exactly which accounts are eligible, so `beforeAll` archives every account the
 * file did not create. That is only acceptable because this file's database is
 * a throwaway: each integration file gets its own in-process PostgreSQL that
 * dies with it. The file therefore refuses to run against anything else — a
 * local database that is not the per-file one (EXTERNAL_TEST_DATABASE_URL), or
 * any remote one.
 *
 * PGlite runs one transaction at a time, so "simultaneous" here means
 * interleaved, not truly parallel. Locking is covered by the existing
 * SKIP LOCKED tests; these cover what M09C adds on top.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const isolated =
  describeDatabaseUrl(DATABASE_URL)?.isLocal === true && !process.env["EXTERNAL_TEST_DATABASE_URL"];
const sql = isolated ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

const PREFIX = "m09c";
const PLAINTEXT = "m09c-not-a-real-password";

let admin: AppUser;

async function services() {
  const prepare = await import("@/modules/quick-prepare");
  const { accountsService } = await import("@/modules/accounts");
  const { problemsService } = await import("@/modules/problems");
  const messages = await import("@/modules/quick-prepare/services/alternative-messages");
  return { ...prepare, accountsService, problemsService, messages };
}

/**
 * A healthy, open-ended account with `free` sellable profiles.
 *
 * `createdAt` is set explicitly so the engine's tie-break (oldest first) is
 * known: accounts made later in a test rank after earlier ones.
 */
async function makeAccount(
  tag: string,
  options: { free?: number; validDays?: number | null; offsetMinutes?: number } = {},
): Promise<{ id: string; email: string }> {
  const { accountsService } = await services();
  const email = `${PREFIX}-${tag}-${randomUUID().slice(0, 8)}@example.invalid`;
  const created = await accountsService.createAccount(
    { ownership: "owned", email, password: PLAINTEXT, country: "DZ", profileSlots: 5 },
    { actor: admin },
  );
  if (!created.ok) throw new Error(created.error.message);

  const id = created.value.id;
  const free = options.free ?? 5;

  /* Fill the slots that should not be free with a throwaway customer. */
  if (free < 5) {
    const holder = await makeCustomer(`${tag}-holder`);
    await sql!`
      update profiles
      set status = 'sold', customer_id = ${holder}::uuid,
          sale_date = current_date - 1, expiration_date = current_date + 300, duration_days = 301
      where account_id = ${id}::uuid and profile_number > ${free}::smallint`;
  }

  if (options.validDays !== undefined) {
    await sql!`
      update accounts
      set valid_from = current_date - 1,
          valid_until = case when ${options.validDays}::int is null then null
                             else current_date + ${options.validDays}::int end
      where id = ${id}::uuid`;
  }

  await sql!`
    update accounts set created_at = now() - interval '1 day' + ${`${options.offsetMinutes ?? 0} minutes`}::interval
    where id = ${id}::uuid`;

  return { id, email };
}

async function makeCustomer(tag: string): Promise<string> {
  const digits = String(Math.floor(600_000_000 + Math.random() * 99_999_999));
  const [row] = await sql!<{ id: string }[]>`
    insert into customers (name, phone_original, phone_normalized, whatsapp_url)
    values (${`${PREFIX}-${tag}`}, ${`+213${digits}`}, ${digits}, ${`https://wa.me/213${digits}`})
    returning id`;
  return row!.id;
}

/** A fresh Algerian mobile number per order, so orders never share a customer by accident. */
function phone(): string {
  return `0663${String(Math.floor(100_000 + Math.random() * 899_999))}`;
}

/** Holds a customer on `profileNumber` of an account, with a known remaining period. */
async function allocate(accountId: string, profileNumber: number, customerId: string) {
  await sql!`
    update profiles
    set status = 'sold', customer_id = ${customerId}::uuid,
        sale_date = current_date - 40, expiration_date = current_date + 50, duration_days = 90
    where account_id = ${accountId}::uuid and profile_number = ${profileNumber}::smallint`;
}

async function profileOwners(accountId: string) {
  return sql!<{ profile_number: number; status: string; customer_id: string | null }[]>`
    select profile_number, status::text, customer_id from profiles
    where account_id = ${accountId}::uuid order by profile_number`;
}

async function soldCount(accountId: string): Promise<number> {
  const [row] = await sql!<{ n: number }[]>`
    select count(*)::int as n from profiles
    where account_id = ${accountId}::uuid and status = 'sold'`;
  return row!.n;
}

beforeAll(async () => {
  if (!isolated) return;

  const [a] = await sql!<{ id: string; name: string; email: string }[]>`
    select id, name, email from users where role = 'super_admin' and deleted_at is null limit 1`;
  admin = { id: a!.id, email: a!.email, displayName: a!.name, initials: "SA", role: "super_admin" };

  /* The seed's stock is out of play for the whole file; see the header. */
  await sql!`update accounts set status = 'archived' where status <> 'archived'`;
});

afterEach(async () => {
  if (!isolated) return;
  /*
   * Each test starts from no eligible stock at all: everything — the seed and
   * the previous test's accounts — is archived. A test sees only what it makes.
   */
  await sql!`update accounts set status = 'archived' where status <> 'archived'`;
});

/** The account ids a Quick Prepare preview would sell from. */
function idsOf(preview: { accounts: readonly { accountId: string }[] }): string[] {
  return preview.accounts.map((account) => account.accountId);
}

/* ======================================================= Quick Prepare: alternatives */

describe.skipIf(!isolated)("Quick Prepare — suggesting another account", () => {
  it("walks through every eligible account, then says there is nothing else", async () => {
    const { quickPrepareService, messages } = await services();
    const first = await makeAccount("walk-a", { offsetMinutes: 1 });
    const second = await makeAccount("walk-b", { offsetMinutes: 2 });
    const third = await makeAccount("walk-c", { offsetMinutes: 3 });
    const order = { profileCount: 1, durationDays: 30 };

    const shown: string[] = [];

    for (let step = 0; step < 3; step += 1) {
      const result = await quickPrepareService.preview({ ...order, excludeAccountIds: shown });
      expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
      if (!result.ok) return;

      const [id] = idsOf(result.value);
      /* Never one already shown — the same account is not offered twice. */
      expect(shown).not.toContain(id);
      shown.push(id!);
    }

    expect(new Set(shown)).toEqual(new Set([first.id, second.id, third.id]));

    /* Everything has been seen: an answer, not the same account again. */
    const exhausted = await quickPrepareService.preview({ ...order, excludeAccountIds: shown });
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) {
      expect(exhausted.error.userMessage).toBe(messages.NO_ALTERNATIVE_MESSAGE);
    }
  });

  it("excludes only for the request that asks — nothing is blacklisted", async () => {
    const { quickPrepareService } = await services();
    const only = await makeAccount("noblacklist");
    const order = { profileCount: 1, durationDays: 30 };

    const turnedDown = await quickPrepareService.preview({
      ...order,
      excludeAccountIds: [only.id],
    });
    expect(turnedDown.ok).toBe(false);

    /* The next order, and anyone else's, sees it as normal. */
    const next = await quickPrepareService.preview(order);
    expect(next.ok && idsOf(next.value)).toEqual([only.id]);

    /* And suggesting reserved nothing: every profile is still free. */
    expect(await soldCount(only.id)).toBe(0);
  });

  it("never offers an account the engine would refuse, however much is excluded", async () => {
    const { quickPrepareService, problemsService, messages } = await services();
    const good = await makeAccount("rules-good", { offsetMinutes: 1 });

    const unhealthy = await makeAccount("rules-unhealthy", { offsetMinutes: 2 });
    await sql!`update accounts set status = 'payment_problem' where id = ${unhealthy.id}::uuid`;

    const blocked = await makeAccount("rules-blocked", { offsetMinutes: 3 });
    const reported = await problemsService.report(
      { accountId: blocked.id, issueType: "incorrect_password", description: "m09c" },
      { actor: admin },
    );
    expect(reported.ok).toBe(true);

    const archived = await makeAccount("rules-archived", { offsetMinutes: 4 });
    await sql!`update accounts set status = 'archived' where id = ${archived.id}::uuid`;

    const deleted = await makeAccount("rules-deleted", { offsetMinutes: 5 });
    await sql!`update accounts set deleted_at = now() where id = ${deleted.id}::uuid`;

    const lapsed = await makeAccount("rules-lapsed", { validDays: -1, offsetMinutes: 6 });
    const tooShort = await makeAccount("rules-short", { validDays: 10, offsetMinutes: 7 });
    const full = await makeAccount("rules-full", { free: 0, offsetMinutes: 8 });
    const tooSmall = await makeAccount("rules-small", { free: 1, offsetMinutes: 9 });

    /* Two profiles for 30 days: `good` qualifies, and nothing else does. */
    const order = { profileCount: 2, durationDays: 30 };

    const first = await quickPrepareService.preview(order);
    expect(first.ok && idsOf(first.value)).toEqual([good.id]);

    /* Turn `good` down: none of the ineligible accounts may step in. */
    const alternative = await quickPrepareService.preview({
      ...order,
      excludeAccountIds: [good.id],
    });
    expect(alternative.ok).toBe(false);
    if (!alternative.ok) {
      expect(alternative.error.userMessage).toBe(messages.NO_ALTERNATIVE_MESSAGE);
    }

    /* Pinning one cannot make it eligible either: the scope only narrows. */
    for (const account of [unhealthy, blocked, archived, deleted, lapsed, tooShort, full]) {
      const pinned = await quickPrepareService.preview({ ...order, accountIds: [account.id] });
      expect(pinned.ok, account.email).toBe(false);
    }

    /* `tooSmall` has one free profile; it can only serve a one-profile order. */
    expect((await quickPrepareService.preview({ ...order, accountIds: [tooSmall.id] })).ok).toBe(
      false,
    );
  });

  it("treats a supplied account exactly as the engine always has", async () => {
    const { quickPrepareService, suppliers } = await (async () => {
      const base = await services();
      const { suppliersService } = await import("@/modules/suppliers");
      return { ...base, suppliers: suppliersService };
    })();

    const supplier = await suppliers.create(
      { name: `${PREFIX}-supplier-${randomUUID().slice(0, 6)}` },
      { actor: admin },
    );
    expect(supplier.ok).toBe(true);
    if (!supplier.ok) return;

    const owned = await makeAccount("own", { offsetMinutes: 1 });
    const supplied = await makeAccount("supplied", { offsetMinutes: 2 });
    const assigned = await suppliers.assign(
      {
        accountId: supplied.id,
        ownership: { ownership: "supplied", supplierId: supplier.value.id },
      },
      { actor: admin },
    );
    expect(assigned.ok).toBe(true);

    /* Provenance is not an allocation rule: the alternative is the supplied one. */
    const alternative = await quickPrepareService.preview({
      profileCount: 1,
      durationDays: 30,
      excludeAccountIds: [owned.id],
    });
    expect(alternative.ok && idsOf(alternative.value)).toEqual([supplied.id]);
  });

  it("replaces the whole set when an order spans several accounts", async () => {
    const { quickPrepareService } = await services();
    const a = await makeAccount("multi-a", { free: 4, offsetMinutes: 1 });
    const b = await makeAccount("multi-b", { free: 4, offsetMinutes: 2 });
    const c = await makeAccount("multi-c", { free: 4, offsetMinutes: 3 });
    const d = await makeAccount("multi-d", { free: 4, offsetMinutes: 4 });

    const order = { profileCount: 6, durationDays: 30 };

    const first = await quickPrepareService.preview(order);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstSet = idsOf(first.value);
    expect(firstSet).toHaveLength(2);

    const second = await quickPrepareService.preview({ ...order, excludeAccountIds: firstSet });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondSet = idsOf(second.value);

    /* Entirely different accounts — none of the first set comes back. */
    expect(secondSet.filter((id) => firstSet.includes(id))).toEqual([]);
    expect(new Set([...firstSet, ...secondSet])).toEqual(new Set([a.id, b.id, c.id, d.id]));
  });

  it("re-checks an earlier suggestion before an operator can go back to it", async () => {
    const { quickPrepareService, problemsService } = await services();
    const earlier = await makeAccount("back-earlier", { offsetMinutes: 1 });
    await makeAccount("back-later", { offsetMinutes: 2 });
    const order = { profileCount: 1, durationDays: 30 };

    const again = await quickPrepareService.preview({ ...order, accountIds: [earlier.id] });
    expect(again.ok && idsOf(again.value)).toEqual([earlier.id]);

    /* It broke while the operator looked at the other one. */
    await problemsService.report(
      { accountId: earlier.id, issueType: "payment_problem", description: "m09c" },
      { actor: admin },
    );

    const gone = await quickPrepareService.preview({ ...order, accountIds: [earlier.id] });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error.userMessage).toMatch(/no longer available/);
  });
});

/* ======================================================= Quick Prepare: confirmation */

describe.skipIf(!isolated)("Quick Prepare — confirming the reviewed account", () => {
  it("sells the alternative the operator chose, not the engine's first choice", async () => {
    const { quickPrepareService } = await services();
    const preferred = await makeAccount("pin-preferred", { offsetMinutes: 1 });
    const chosen = await makeAccount("pin-chosen", { offsetMinutes: 2 });

    const result = await quickPrepareService.confirm(
      {
        profileCount: 1,
        durationDays: 30,
        phone: phone(),
        accountIds: [chosen.id],
        operationId: randomUUID(),
      },
      { actor: admin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.accounts.map((account) => account.accountId)).toEqual([chosen.id]);
    expect(await soldCount(chosen.id)).toBe(1);
    expect(await soldCount(preferred.id)).toBe(0);
  });

  it("refuses a stale review instead of selling something else", async () => {
    const { quickPrepareService } = await services();
    const reviewed = await makeAccount("stale-reviewed", { offsetMinutes: 1 });
    const other = await makeAccount("stale-other", { offsetMinutes: 2 });

    /* The reviewed account is sold out between review and confirmation. */
    const holder = await makeCustomer("stale-holder");
    await sql!`
      update profiles set status = 'sold', customer_id = ${holder}::uuid,
        sale_date = current_date, expiration_date = current_date + 30, duration_days = 30
      where account_id = ${reviewed.id}::uuid`;

    const operationId = randomUUID();
    const result = await quickPrepareService.confirm(
      { profileCount: 1, durationDays: 30, phone: phone(), accountIds: [reviewed.id], operationId },
      { actor: admin },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.userMessage).toMatch(/no longer available/);
    }

    /* Nothing substituted, nothing written, no receipt left to replay. */
    expect(await soldCount(other.id)).toBe(0);
    const receipts = await sql!<{ n: number }[]>`
      select count(*)::int as n from idempotency_keys where key = ${operationId}`;
    expect(receipts[0]!.n).toBe(0);
  });

  it("lets two operators who reviewed the same last profile sell it exactly once", async () => {
    const { quickPrepareService } = await services();
    const last = await makeAccount("race", { free: 1, offsetMinutes: 1 });

    const order = (number: string) => ({
      profileCount: 1,
      durationDays: 30,
      phone: number,
      accountIds: [last.id],
      operationId: randomUUID(),
    });

    const [left, right] = await Promise.all([
      quickPrepareService.confirm(order(phone()), { actor: admin }),
      quickPrepareService.confirm(order(phone()), { actor: admin }),
    ]);

    /* One sale, one refusal — never two customers on one profile. */
    expect([left.ok, right.ok].filter(Boolean)).toHaveLength(1);
    const owners = (await profileOwners(last.id)).filter((row) => row.profile_number === 1);
    expect(owners[0]?.status).toBe("sold");
    expect(await soldCount(last.id)).toBe(5);
  });

  it("replays a retry of the same order, and refuses the same key for another account", async () => {
    const { quickPrepareService } = await services();
    const first = await makeAccount("idem-first", { free: 2, offsetMinutes: 1 });
    const second = await makeAccount("idem-second", { offsetMinutes: 2 });

    const customerPhone = phone();
    const operationId = randomUUID();
    const order = {
      profileCount: 1,
      durationDays: 30,
      phone: customerPhone,
      accountIds: [first.id],
      operationId,
    };

    const original = await quickPrepareService.confirm(order, { actor: admin });
    expect(original.ok, original.ok ? "" : original.error.message).toBe(true);

    /* A network retry: same key, same order — replayed, not sold again. */
    const retry = await quickPrepareService.confirm(order, { actor: admin });
    expect(retry.ok && retry.value.replayed).toBe(true);
    expect(await soldCount(first.id)).toBe(4);

    /* The same key for a different account is a different order: refused. */
    const reused = await quickPrepareService.confirm(
      { ...order, accountIds: [second.id] },
      { actor: admin },
    );
    expect(reused.ok).toBe(false);
    expect(await soldCount(second.id)).toBe(0);

    /* A deliberate new order for the alternative gets its own key and goes through. */
    const intentional = await quickPrepareService.confirm(
      { ...order, phone: phone(), accountIds: [second.id], operationId: randomUUID() },
      { actor: admin },
    );
    expect(intentional.ok, intentional.ok ? "" : intentional.error.message).toBe(true);
    expect(await soldCount(second.id)).toBe(1);
  });

  it("keeps working without a review for server callers, exactly as before", async () => {
    const { quickPrepareService } = await services();
    const only = await makeAccount("legacy");

    const result = await quickPrepareService.confirm(
      { profileCount: 1, durationDays: 30, phone: phone() },
      { actor: admin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    expect(await soldCount(only.id)).toBe(1);
  });
});

/* ======================================================= Quick Replace */

describe.skipIf(!isolated)("Quick Replace — suggesting another replacement", () => {
  /** A failing account with one customer on profile 1, and three healthy targets. */
  async function scenario(tag: string) {
    const failing = await makeAccount(`${tag}-failing`, { offsetMinutes: 0 });
    const customerId = await makeCustomer(`${tag}-customer`);
    await allocate(failing.id, 1, customerId);
    await sql!`update accounts set status = 'payment_problem' where id = ${failing.id}::uuid`;

    const targets = [
      await makeAccount(`${tag}-t1`, { offsetMinutes: 1 }),
      await makeAccount(`${tag}-t2`, { offsetMinutes: 2 }),
      await makeAccount(`${tag}-t3`, { offsetMinutes: 3 }),
    ];

    return { failing, customerId, targets };
  }

  it("offers each other account for the same customer and profile, then stops", async () => {
    const { quickReplaceService } = await services();
    const { failing, customerId, targets } = await scenario("walk");

    const first = await quickReplaceService.preview({ accountEmail: failing.email });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const target = first.value.selected!;
    const heldIds = target.profiles.map((profile) => profile.id);
    const shown = [first.value.replacement!.account.id];

    for (let step = 0; step < 2; step += 1) {
      const next = await quickReplaceService.preview({
        accountEmail: failing.email,
        customerId,
        excludeAccountIds: shown,
      });
      expect(next.ok).toBe(true);
      if (!next.ok) return;

      /* The customer and the profiles being replaced never move. */
      expect(next.value.selected?.customer.id).toBe(customerId);
      expect(next.value.selected?.profiles.map((profile) => profile.id)).toEqual(heldIds);

      const id = next.value.replacement!.account.id;
      expect(shown).not.toContain(id);
      /* The failing account is never proposed, whatever the list says. */
      expect(id).not.toBe(failing.id);
      shown.push(id);
    }

    expect(new Set(shown)).toEqual(new Set(targets.map((account) => account.id)));

    const exhausted = await quickReplaceService.preview({
      accountEmail: failing.email,
      customerId,
      excludeAccountIds: shown,
    });
    expect(exhausted.ok && exhausted.value.replacement).toBeNull();
    expect(exhausted.ok && exhausted.value.blockedReason).toBe("no_other_account");
  });

  it("commits the alternative the operator chose, keeping the customer's expiry", async () => {
    const { quickReplaceService, quickPrepareService } = await services();
    const { failing, customerId } = await scenario("commit");

    const first = await quickReplaceService.preview({ accountEmail: failing.email });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const alternative = await quickReplaceService.preview({
      accountEmail: failing.email,
      customerId,
      excludeAccountIds: [first.value.replacement!.account.id],
    });
    expect(alternative.ok).toBe(true);
    if (!alternative.ok) return;

    const chosen = alternative.value.replacement!.account.id;
    const held = alternative.value.selected!.profiles;

    const result = await quickPrepareService.confirmReplacement(
      {
        accountId: failing.id,
        customerId,
        expectedProfileIds: held.map((profile) => profile.id),
        replacementAccountId: chosen,
        passwordChangeConfirmed: true,
        operationId: randomUUID(),
      },
      { actor: admin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.accounts.map((account) => account.accountId)).toEqual([chosen]);
    expect(result.value.expirationDate).toBe(held[0]!.expirationDate);
    /* The first proposal was only shown, never touched. */
    expect(await soldCount(first.value.replacement!.account.id)).toBe(0);
  });

  it("re-checks an earlier proposal, and refuses a stale one at commit", async () => {
    const { quickReplaceService, quickPrepareService, problemsService } = await services();
    const { failing, customerId } = await scenario("stale");

    const first = await quickReplaceService.preview({ accountEmail: failing.email });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const proposed = first.value.replacement!.account.id;
    const held = first.value.selected!.profiles.map((profile) => profile.id);

    /* Going back to it while it is still fine returns it. */
    const back = await quickReplaceService.preview({
      accountEmail: failing.email,
      customerId,
      replacementAccountId: proposed,
    });
    expect(back.ok && back.value.replacement?.account.id).toBe(proposed);

    /* Then it develops a problem. */
    await problemsService.report(
      { accountId: proposed, issueType: "invalid_email", description: "m09c" },
      { actor: admin },
    );

    const gone = await quickReplaceService.preview({
      accountEmail: failing.email,
      customerId,
      replacementAccountId: proposed,
    });
    expect(gone.ok && gone.value.blockedReason).toBe("proposal_unavailable");

    const commit = await quickPrepareService.confirmReplacement(
      {
        accountId: failing.id,
        customerId,
        expectedProfileIds: held,
        replacementAccountId: proposed,
        passwordChangeConfirmed: true,
        operationId: randomUUID(),
      },
      { actor: admin },
    );
    expect(commit.ok).toBe(false);

    /* Refused cleanly: the customer is still exactly where they were. */
    const stillThere = (await profileOwners(failing.id)).find((row) => row.profile_number === 1);
    expect(stillThere?.customer_id).toBe(customerId);
  });
});
