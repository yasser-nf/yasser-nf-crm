import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M09A Quick Renewing, against the real schema.
 *
 * Every test builds its own account, customer and allocation, so none of them
 * depends on the seed's stock or on another test's leftovers.
 *
 * LOCAL ONLY.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;
const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

const PREFIX = "m09a";
const PLAINTEXT = "m09a-not-a-real-password";

let admin: AppUser;
let worker: AppUser;

async function modules() {
  const renew = await import("@/modules/quick-renew");
  const { accountsService } = await import("@/modules/accounts");
  return { ...renew, accountsService };
}

async function makeAccount(tag: string): Promise<{ id: string; email: string }> {
  const { accountsService } = await modules();
  const email = `${PREFIX}-${tag}-${randomUUID().slice(0, 8)}@example.invalid`;
  const created = await accountsService.createAccount(
    { ownership: "owned", email, password: PLAINTEXT, country: "DZ", profileSlots: 5 },
    { actor: admin },
  );
  if (!created.ok) throw new Error(created.error.message);
  return { id: created.value.id, email };
}

async function makeCustomer(tag: string): Promise<string> {
  const digits = String(Math.floor(600_000_000 + Math.random() * 99_999_999));
  const [row] = await sql!<{ id: string }[]>`
    insert into customers (name, phone_original, phone_normalized, whatsapp_url)
    values (${`${PREFIX}-${tag}`}, ${`+213${digits}`}, ${digits}, ${`https://wa.me/213${digits}`})
    returning id`;
  return row!.id;
}

/** Sells one slot to a customer, with dates chosen by the test. */
async function allocate(
  accountId: string,
  profileNumber: number,
  customerId: string,
  dates: { saleDate: string; expirationDate: string },
): Promise<string> {
  const days = Math.round(
    (Date.parse(`${dates.expirationDate}T00:00:00Z`) - Date.parse(`${dates.saleDate}T00:00:00Z`)) /
      86_400_000,
  );
  const [row] = await sql!<{ id: string }[]>`
    update profiles
    set status = 'sold', customer_id = ${customerId}::uuid,
        sale_date = ${dates.saleDate}::date, expiration_date = ${dates.expirationDate}::date,
        duration_days = ${days}::int
    where account_id = ${accountId}::uuid and profile_number = ${profileNumber}::smallint
    returning id`;
  return row!.id;
}

async function profileRow(id: string) {
  const [row] = await sql!<
    {
      status: string;
      customer_id: string | null;
      sale_date: string | null;
      expiration_date: string | null;
      duration_days: number | null;
      profile_number: number;
    }[]
  >`select status::text, customer_id, to_char(sale_date,'YYYY-MM-DD') sale_date,
           to_char(expiration_date,'YYYY-MM-DD') expiration_date, duration_days, profile_number
    from profiles where id = ${id}::uuid`;
  return row!;
}

/** Today and a date a given number of days from it, as the database sees them. */
async function dateOffsets(...offsets: number[]): Promise<string[]> {
  const [row] = await sql!<{ values: string[] }[]>`
    select array(select to_char(current_date + o, 'YYYY-MM-DD') from unnest(${offsets}::int[]) o) as values`;
  return row!.values;
}

beforeAll(async () => {
  if (!local) return;
  const [a] = await sql!<{ id: string; name: string; email: string }[]>`
    select id, name, email from users where role = 'super_admin' and deleted_at is null limit 1`;
  const [w] = await sql!<{ id: string; name: string; email: string }[]>`
    select id, name, email from users where role = 'worker' and deleted_at is null limit 1`;
  admin = { id: a!.id, email: a!.email, displayName: a!.name, initials: "SA", role: "super_admin" };
  worker = { id: w!.id, email: w!.email, displayName: w!.name, initials: "W", role: "worker" };
});

afterAll(async () => {
  if (!local) return;
  await sql!`delete from accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!`delete from customers where name like ${`${PREFIX}-%`}`;
  await sql!.end({ timeout: 5 });
});

/* ------------------------------------------------------------- authorization */

describe.skipIf(!local)("authorization", () => {
  it("refuses every operation to the signed-out, and allows both roles that hold the permission", async () => {
    const { quickRenewService } = await modules();
    const account = await makeAccount("auth");
    const customer = await makeCustomer("auth");
    const [sale, expiry] = await dateOffsets(-30, 30);
    const profileId = await allocate(account.id, 1, customer, {
      saleDate: sale!,
      expirationDate: expiry!,
    });

    const duration = { unit: "months", months: 1 } as const;

    for (const call of [
      quickRenewService.searchAccounts({ email: account.email }, null),
      quickRenewService.listProfiles(account.id, null),
      quickRenewService.preview({ profileId, duration }, null),
      quickRenewService.confirm(
        { profileId, duration, expectedExpirationDate: expiry! },
        { actor: null },
      ),
    ]) {
      const result = await call;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    }

    /* Workers sell and replace, so they renew too — the permission says so. */
    expect((await quickRenewService.preview({ profileId, duration }, worker)).ok).toBe(true);
    expect((await quickRenewService.preview({ profileId, duration }, admin)).ok).toBe(true);
    expect(await profileRow(profileId)).toMatchObject({ expiration_date: expiry });
  });
});

/* -------------------------------------------------------------- the renewal */

describe.skipIf(!local)("renewing a running subscription", () => {
  it("extends only the chosen profile, keeps its customer, and restates the duration", async () => {
    const { quickRenewService } = await modules();
    const account = await makeAccount("extend");
    const customer = await makeCustomer("extend");
    const other = await makeCustomer("extend-other");
    const [sale, expiry] = await dateOffsets(-30, 30);

    const target = await allocate(account.id, 1, customer, {
      saleDate: sale!,
      expirationDate: expiry!,
    });
    const untouched = await allocate(account.id, 2, other, {
      saleDate: sale!,
      expirationDate: expiry!,
    });
    const before = await profileRow(untouched);

    const preview = await quickRenewService.preview(
      { profileId: target, duration: { unit: "months", months: 3 } },
      admin,
    );
    expect(preview.ok, preview.ok ? "" : preview.error.message).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.basis).toBe("continues");
    expect(preview.value.currentExpirationDate).toBe(expiry);
    expect(preview.value.customer.id).toBe(customer);

    const confirmed = await quickRenewService.confirm(
      {
        profileId: target,
        duration: { unit: "months", months: 3 },
        expectedExpirationDate: expiry!,
        operationId: randomUUID(),
      },
      { actor: admin },
    );
    expect(confirmed.ok, confirmed.ok ? "" : confirmed.error.message).toBe(true);
    if (!confirmed.ok) return;

    expect(confirmed.value.newExpirationDate).toBe(preview.value.newExpirationDate);
    expect(confirmed.value.replayed).toBe(false);

    const after = await profileRow(target);
    expect(after.expiration_date).toBe(preview.value.newExpirationDate);
    expect(after.customer_id).toBe(customer);
    expect(after.sale_date).toBe(sale);
    expect(after.status).toBe("sold");

    /* The invariant the profile editor derives from: sale + duration = expiry. */
    const [derived] = await sql!<{ d: string }[]>`
      select to_char(sale_date + duration_days, 'YYYY-MM-DD') d from profiles where id = ${target}::uuid`;
    expect(derived!.d).toBe(after.expiration_date);

    /* Nothing else on the account moved. */
    expect(await profileRow(untouched)).toEqual(before);
  });

  it("records an `extended` event and an audit entry, with no secrets", async () => {
    const { quickRenewService } = await modules();
    const account = await makeAccount("events");
    const customer = await makeCustomer("events");
    const [sale, expiry] = await dateOffsets(-10, 20);
    const target = await allocate(account.id, 1, customer, {
      saleDate: sale!,
      expirationDate: expiry!,
    });
    await sql!`update profiles set pin = '4321' where id = ${target}::uuid`;

    const confirmed = await quickRenewService.confirm(
      {
        profileId: target,
        duration: { unit: "days", days: 15 },
        expectedExpirationDate: expiry!,
        operationId: randomUUID(),
      },
      { actor: admin },
    );
    expect(confirmed.ok).toBe(true);

    /* `created` events come from account creation; the renewal's own is `extended`. */
    const events = await sql!<{ event_type: string; metadata: Record<string, unknown> }[]>`
      select event_type::text, metadata from profile_events
      where profile_id = ${target}::uuid and event_type = 'extended'`;
    expect(events).toHaveLength(1);
    const metadata = events[0]!.metadata as {
      from?: Record<string, unknown>;
      to?: Record<string, unknown>;
    };
    expect(metadata.from).toMatchObject({ expirationDate: expiry });
    expect(metadata.to).toMatchObject({
      expirationDate: confirmed.ok ? confirmed.value.newExpirationDate : "",
    });

    const audits = await sql!<{ action: string; after: Record<string, unknown> }[]>`
      select action::text, after from audit_logs
      where entity = 'profile' and entity_id = ${target}::uuid order by created_at desc limit 1`;
    expect(audits[0]?.action).toBe("update");

    const serialized = JSON.stringify({ events, audits });
    expect(serialized).not.toContain("4321");
    expect(serialized).not.toContain(PLAINTEXT);
    expect(serialized).not.toMatch(/"pin"\s*:\s*"/);
  });

  it("renews a lapsed subscription from today, and says it restarts", async () => {
    const { quickRenewService } = await modules();
    const account = await makeAccount("lapsed");
    const customer = await makeCustomer("lapsed");
    const [sale, expired, today, inOneMonth] = await dateOffsets(-120, -40, 0, 0);
    const target = await allocate(account.id, 1, customer, {
      saleDate: sale!,
      expirationDate: expired!,
    });
    void inOneMonth;

    const preview = await quickRenewService.preview(
      { profileId: target, duration: { unit: "months", months: 1 } },
      admin,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.value.basis).toBe("restarts");
    const warning = preview.value.warnings.join(" ");
    expect(warning).toContain(`expired on ${expired}`);
    expect(warning).toContain("runs from today");

    const confirmed = await quickRenewService.confirm(
      {
        profileId: target,
        duration: { unit: "months", months: 1 },
        expectedExpirationDate: expired!,
        operationId: randomUUID(),
      },
      { actor: admin },
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;

    /* One calendar month from today, not from the old expiry. */
    const [expected] = await sql!<{ d: string }[]>`
      select to_char((current_date + interval '1 month')::date, 'YYYY-MM-DD') d`;
    expect(confirmed.value.newExpirationDate).toBe(expected!.d);
    expect(confirmed.value.basis).toBe("restarts");
    expect(Number((await profileRow(target)).duration_days)).toBeGreaterThan(0);
    void today;
  });
});

/* --------------------------------------------------------------- refusals */

describe.skipIf(!local)("what cannot be renewed", () => {
  it("refuses a slot nobody holds, and one with no dates", async () => {
    const { quickRenewService } = await modules();
    const account = await makeAccount("refuse");
    const duration = { unit: "months", months: 1 } as const;

    const slots = await quickRenewService.listProfiles(account.id, admin);
    expect(slots.ok).toBe(true);
    if (!slots.ok) return;

    expect(slots.value.profiles).toHaveLength(5);
    expect(slots.value.profiles.every((slot) => !slot.renewable)).toBe(true);
    expect(slots.value.profiles[0]?.blockedReason).toMatch(/No customer holds this profile/);

    const free = slots.value.profiles[0]!.profile.id;
    const refused = await quickRenewService.preview({ profileId: free, duration }, admin);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.userMessage).toMatch(/No customer holds/);

    /* Held, but with no recorded period. */
    const customer = await makeCustomer("refuse-nodates");
    await sql!`update profiles set status='sold', customer_id=${customer}::uuid,
               sale_date=null, expiration_date=null, duration_days=null
               where account_id=${account.id}::uuid and profile_number=2`;
    const [{ id: undated } = { id: "" }] = await sql!<{ id: string }[]>`
      select id from profiles where account_id=${account.id}::uuid and profile_number=2`;

    const noDates = await quickRenewService.preview({ profileId: undated, duration }, admin);
    expect(noDates.ok).toBe(false);
    if (!noDates.ok) expect(noDates.error.userMessage).toMatch(/no recorded expiry/);
  });

  it("refuses while the account has an open problem, and writes nothing", async () => {
    const { quickRenewService } = await modules();
    const { problemsService } = await import("@/modules/problems");
    const account = await makeAccount("blocked");
    const customer = await makeCustomer("blocked");
    const [sale, expiry] = await dateOffsets(-10, 20);
    const target = await allocate(account.id, 1, customer, {
      saleDate: sale!,
      expirationDate: expiry!,
    });

    const reported = await problemsService.report(
      { accountId: account.id, issueType: "payment_problem", description: "m09a test problem" },
      { actor: admin },
    );
    expect(reported.ok, reported.ok ? "" : reported.error.message).toBe(true);

    const duration = { unit: "months", months: 1 } as const;
    const preview = await quickRenewService.preview({ profileId: target, duration }, admin);
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error.userMessage).toMatch(/open problem/);

    const confirmed = await quickRenewService.confirm(
      { profileId: target, duration, expectedExpirationDate: expiry!, operationId: randomUUID() },
      { actor: admin },
    );
    expect(confirmed.ok).toBe(false);
    expect((await profileRow(target)).expiration_date).toBe(expiry);
  });

  it("refuses a renewal that would outlast the account's own validity", async () => {
    const { quickRenewService } = await modules();
    const account = await makeAccount("validity");
    const customer = await makeCustomer("validity");
    const [sale, expiry, validUntil] = await dateOffsets(-10, 20, 40);
    const target = await allocate(account.id, 1, customer, {
      saleDate: sale!,
      expirationDate: expiry!,
    });
    await sql!`update accounts set valid_until = ${validUntil!}::date where id = ${account.id}::uuid`;

    const refused = await quickRenewService.preview(
      { profileId: target, duration: { unit: "months", months: 12 } },
      admin,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.userMessage).toMatch(/only covered for/);

    /* A period the account can cover is still fine. */
    const allowed = await quickRenewService.preview(
      { profileId: target, duration: { unit: "days", days: 10 } },
      admin,
    );
    expect(allowed.ok).toBe(true);
  });

  it("refuses a stale preview rather than applying it to a changed period", async () => {
    const { quickRenewService } = await modules();
    const account = await makeAccount("stale");
    const customer = await makeCustomer("stale");
    const [sale, expiry, moved] = await dateOffsets(-10, 20, 25);
    const target = await allocate(account.id, 1, customer, {
      saleDate: sale!,
      expirationDate: expiry!,
    });

    /* Someone else renewed it while the operator was reading the preview. */
    await sql!`update profiles set expiration_date = ${moved!}::date where id = ${target}::uuid`;

    const confirmed = await quickRenewService.confirm(
      {
        profileId: target,
        duration: { unit: "months", months: 1 },
        expectedExpirationDate: expiry!,
        operationId: randomUUID(),
      },
      { actor: admin },
    );

    expect(confirmed.ok).toBe(false);
    if (!confirmed.ok) {
      expect(confirmed.error.code).toBe("CONFLICT");
      expect(confirmed.error.userMessage).toMatch(/changed while you were reviewing/);
    }
    expect((await profileRow(target)).expiration_date).toBe(moved);
  });

  it("refuses an invalid duration without touching the row", async () => {
    const { quickRenewService } = await modules();
    const account = await makeAccount("duration");
    const customer = await makeCustomer("duration");
    const [sale, expiry] = await dateOffsets(-10, 20);
    const target = await allocate(account.id, 1, customer, {
      saleDate: sale!,
      expirationDate: expiry!,
    });

    for (const duration of [
      { unit: "months", months: 5 },
      { unit: "days", days: 0 },
      { unit: "days", days: -10 },
      { unit: "days", days: 2.5 },
      { unit: "days", days: 100000 },
      { unit: "weeks", weeks: 2 },
    ]) {
      const refused = await quickRenewService.confirm(
        {
          profileId: target,
          duration,
          expectedExpirationDate: expiry!,
          operationId: randomUUID(),
        },
        { actor: admin },
      );
      expect(refused.ok, JSON.stringify(duration)).toBe(false);
    }

    expect((await profileRow(target)).expiration_date).toBe(expiry);
  });
});

/* ------------------------------------------------------------ idempotency */

describe.skipIf(!local)("a repeat does not renew twice", () => {
  it("replays the first result for the same operation id", async () => {
    const { quickRenewService } = await modules();
    const account = await makeAccount("idem");
    const customer = await makeCustomer("idem");
    const [sale, expiry] = await dateOffsets(-10, 20);
    const target = await allocate(account.id, 1, customer, {
      saleDate: sale!,
      expirationDate: expiry!,
    });

    const request = {
      profileId: target,
      duration: { unit: "months", months: 1 } as const,
      expectedExpirationDate: expiry!,
      operationId: randomUUID(),
    };

    const first = await quickRenewService.confirm(request, { actor: admin });
    const second = await quickRenewService.confirm(request, { actor: admin });

    expect(first.ok, first.ok ? "" : first.error.message).toBe(true);
    expect(second.ok, second.ok ? "" : second.error.message).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.value.replayed).toBe(false);
    expect(second.value.replayed).toBe(true);
    expect(second.value.newExpirationDate).toBe(first.value.newExpirationDate);

    /* The period moved once, and there is one event to show for it. */
    expect((await profileRow(target)).expiration_date).toBe(first.value.newExpirationDate);
    const [{ n } = { n: -1 }] = await sql!<{ n: number }[]>`
      select count(*)::int n from profile_events
      where profile_id = ${target}::uuid and event_type = 'extended'`;
    expect(n).toBe(1);
  });

  it("three copies of one renewal at once still add the period once", async () => {
    const { quickRenewService } = await modules();
    const account = await makeAccount("idem-race");
    const customer = await makeCustomer("idem-race");
    const [sale, expiry] = await dateOffsets(-10, 20);
    const target = await allocate(account.id, 1, customer, {
      saleDate: sale!,
      expirationDate: expiry!,
    });

    const request = {
      profileId: target,
      duration: { unit: "months", months: 2 } as const,
      expectedExpirationDate: expiry!,
      operationId: randomUUID(),
    };

    const results = await Promise.all(
      [1, 2, 3].map(() => quickRenewService.confirm(request, { actor: admin })),
    );

    for (const result of results)
      expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    const values = results.flatMap((result) => (result.ok ? [result.value] : []));
    expect(values.filter((value) => !value.replayed)).toHaveLength(1);
    expect(new Set(values.map((value) => value.newExpirationDate)).size).toBe(1);

    const [{ n } = { n: -1 }] = await sql!<{ n: number }[]>`
      select count(*)::int n from profile_events
      where profile_id = ${target}::uuid and event_type = 'extended'`;
    expect(n).toBe(1);
  });

  it("a second, genuinely new renewal extends from the new expiry", async () => {
    const { quickRenewService } = await modules();
    const account = await makeAccount("twice");
    const customer = await makeCustomer("twice");
    const [sale, expiry] = await dateOffsets(-10, 20);
    const target = await allocate(account.id, 1, customer, {
      saleDate: sale!,
      expirationDate: expiry!,
    });

    const first = await quickRenewService.confirm(
      {
        profileId: target,
        duration: { unit: "months", months: 1 },
        expectedExpirationDate: expiry!,
        operationId: randomUUID(),
      },
      { actor: admin },
    );
    if (!first.ok) throw new Error(first.error.message);

    const second = await quickRenewService.confirm(
      {
        profileId: target,
        duration: { unit: "months", months: 1 },
        expectedExpirationDate: first.value.newExpirationDate,
        operationId: randomUUID(),
      },
      { actor: admin },
    );
    expect(second.ok, second.ok ? "" : second.error.message).toBe(true);
    if (!second.ok) return;

    expect(second.value.previousExpirationDate).toBe(first.value.newExpirationDate);
    expect(second.value.newExpirationDate).not.toBe(first.value.newExpirationDate);
    expect((await profileRow(target)).expiration_date).toBe(second.value.newExpirationDate);
  });
});

/* ------------------------------------------------------------------ search */

describe.skipIf(!local)("account search", () => {
  it("matches part of an email, escapes wildcards, and never returns a password", async () => {
    const { quickRenewService } = await modules();
    const account = await makeAccount("search");
    const fragment = account.email.slice(0, 18);

    const found = await quickRenewService.searchAccounts({ email: fragment }, admin);
    expect(found.ok).toBe(true);
    if (!found.ok) return;

    expect(found.value.some((match) => match.account.id === account.id)).toBe(true);
    const serialized = JSON.stringify(found.value);
    expect(serialized).not.toContain("passwordEncrypted");
    expect(serialized).not.toContain("password_encrypted");
    expect(serialized).not.toContain(PLAINTEXT);

    /* A typed wildcard is a literal, not "every account". */
    const wildcard = await quickRenewService.searchAccounts({ email: "%%" }, admin);
    expect(wildcard.ok, wildcard.ok ? "" : wildcard.error.message).toBe(true);
    expect(wildcard.ok ? wildcard.value : null).toHaveLength(0);

    /* Deleted accounts are out of reach. */
    await sql!`update accounts set deleted_at = now() where id = ${account.id}::uuid`;
    const afterDelete = await quickRenewService.searchAccounts({ email: fragment }, admin);
    expect(afterDelete.ok && afterDelete.value.some((m) => m.account.id === account.id)).toBe(
      false,
    );
  });
});

/* --------------------------------------------------- what a receipt holds */

describe.skipIf(!local)("the renewal receipt", () => {
  it("records references only — no name, phone or credential", async () => {
    const { quickRenewService } = await modules();
    const account = await makeAccount("receipt");
    const customer = await makeCustomer("receipt");
    const [sale, expiry] = await dateOffsets(-10, 20);
    const target = await allocate(account.id, 1, customer, {
      saleDate: sale!,
      expirationDate: expiry!,
    });
    const [{ phone_original: phone } = { phone_original: "" }] = await sql!<
      { phone_original: string }[]
    >`select phone_original from customers where id = ${customer}::uuid`;

    const operationId = randomUUID();
    const confirmed = await quickRenewService.confirm(
      {
        profileId: target,
        duration: { unit: "months", months: 1 },
        expectedExpirationDate: expiry!,
        operationId,
      },
      { actor: admin },
    );
    expect(confirmed.ok).toBe(true);

    const [receipt] = await sql!<{ scope: string; result: Record<string, unknown> }[]>`
      select scope, result from idempotency_keys where key = ${operationId}`;
    expect(receipt?.scope).toBe("quick_renew.confirm");

    const stored = receipt!.result as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      "basis",
      "durationLabel",
      "newExpirationDate",
      "previousExpirationDate",
      "profileId",
    ]);

    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(phone);
    expect(serialized).not.toContain(account.email);
    expect(serialized).not.toContain(PLAINTEXT);

    /* The replay still names the customer, by reading the live row. */
    const replayed = await quickRenewService.confirm(
      {
        profileId: target,
        duration: { unit: "months", months: 1 },
        expectedExpirationDate: expiry!,
        operationId,
      },
      { actor: admin },
    );
    expect(replayed.ok && replayed.value.replayed).toBe(true);
    expect(replayed.ok && replayed.value.customerPhone).toBe(phone);
    expect(replayed.ok && replayed.value.accountEmail).toBe(account.email);
  });
});
