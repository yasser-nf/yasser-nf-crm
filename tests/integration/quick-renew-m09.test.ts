import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * Quick Renew, end to end against a real database. M09 §20.
 *
 * What can only be tested here rather than as a unit:
 *
 *   - that `preview` and `quote` write NOTHING
 *   - that a renewal, its history event and its audit entry are one atomic unit
 *   - that a stale confirmation is refused by a transaction re-reading under
 *     lock, which no mock can demonstrate
 *   - that two operators renewing the same profile produce ONE renewal
 *   - that the row, the event and the audit trail agree afterwards
 *
 * Concurrency, honestly: the isolated database runs one transaction at a time,
 * so the "at once" cases interleave at transaction boundaries. That is exactly
 * the window that matters — the second request's checks run before or after
 * the first commits, and both orders must end in one renewal.
 *
 * LOCAL ONLY. Every fixture is created by the test, so nothing depends on seed
 * stock and nothing can touch a real account.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;
const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

const PREFIX = "m09-renew";
const PLAINTEXT = "m09-not-a-real-password";

let admin: AppUser;
let worker: AppUser;

async function services() {
  const renew = await import("@/modules/quick-renew");
  const { accountsService } = await import("@/modules/accounts");
  return { ...renew, accountsService };
}

function email(tag: string): string {
  return `${PREFIX}-${tag}-${randomUUID().slice(0, 8)}@example.invalid`;
}

async function makeAccount(
  tag: string,
  options: { profileSlots?: number; validUntil?: string | null } = {},
): Promise<{ id: string; email: string }> {
  const { accountsService } = await services();
  const address = email(tag);

  const created = await accountsService.createAccount(
    { email: address, password: PLAINTEXT, country: "DZ", profileSlots: options.profileSlots ?? 5 },
    { actor: admin },
  );

  if (!created.ok) throw new Error(created.error.message);

  if (options.validUntil !== undefined) {
    await sql!`update accounts set valid_until = ${options.validUntil} where id = ${created.value.id}::uuid`;
  }

  return { id: created.value.id, email: address };
}

async function makeCustomer(tag: string): Promise<string> {
  const digits = String(Math.floor(600_000_000 + Math.random() * 99_999_999));

  const rows = await sql!<{ id: string }[]>`
    insert into public.customers (name, phone_original, phone_normalized, whatsapp_url)
    values (${`${PREFIX}-${tag}`}, ${`+213${digits}`}, ${digits}, ${`https://wa.me/213${digits}`})
    returning id`;

  return rows[0]!.id;
}

/** Sells a profile with an explicit window, so each test states its own dates. */
async function allocate(
  accountId: string,
  profileNumber: number,
  customerId: string,
  { soldDaysAgo, expiresInDays }: { soldDaysAgo: number; expiresInDays: number },
): Promise<string> {
  const rows = await sql!<{ id: string }[]>`
    update public.profiles
    set status = 'sold',
        customer_id = ${customerId}::uuid,
        sale_date = current_date - ${soldDaysAgo}::int,
        expiration_date = current_date + ${expiresInDays}::int,
        duration_days = ${soldDaysAgo + expiresInDays}::int
    where account_id = ${accountId}::uuid and profile_number = ${profileNumber}::smallint
    returning id`;

  return rows[0]!.id;
}

async function profileRow(profileId: string) {
  const rows = await sql!<
    {
      status: string;
      customer_id: string | null;
      worker_id: string | null;
      sale_date: string;
      expiration_date: string;
      duration_days: number;
    }[]
  >`select status, customer_id, worker_id, sale_date::text, expiration_date::text, duration_days
    from profiles where id = ${profileId}::uuid`;

  return rows[0]!;
}

async function eventsFor(profileId: string) {
  return sql!<{ event_type: string; user_id: string | null; metadata: Record<string, unknown> }[]>`
    select event_type, user_id, metadata from profile_events
    where profile_id = ${profileId}::uuid order by created_at asc`;
}

async function renewalAudits(profileId: string) {
  return sql!<{ before: Record<string, unknown>; after: Record<string, unknown> }[]>`
    select before, after from audit_logs
    where entity = 'profile' and entity_id = ${profileId}::uuid
      and after->>'event' = 'profile_renewed'
    order by created_at asc`;
}

async function receipts(key: string) {
  return sql!<{ result: Record<string, unknown> | null; actor_id: string | null }[]>`
    select result, actor_id from idempotency_keys
    where scope = 'quick_renew.confirm' and key = ${key}`;
}

/** The date `days` from today, as the database itself computes it. */
async function dateIn(days: number): Promise<string> {
  const rows = await sql!<{ d: string }[]>`select (current_date + ${days}::int)::text as d`;
  return rows[0]!.d;
}

const preset = (id: string) => ({ kind: "preset" as const, preset: id });
const custom = (days: number) => ({ kind: "custom" as const, days });

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
  await sql?.end({ timeout: 5 });
});

/* ------------------------------------------------------------- the lookup */

describe.skipIf(!local)("finding the account", () => {
  it("returns the account, its slots and who holds them", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("lookup");
    const customer = await makeCustomer("lookup");
    await allocate(account.id, 2, customer, { soldDaysAgo: 10, expiresInDays: 20 });

    const result = await quickRenewService.preview(
      { accountEmail: account.email },
      { actor: admin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.account.email).toBe(account.email);
    expect(result.value.profiles).toHaveLength(5);
    expect(result.value.accountBlocksRenewal).toBe(false);

    const held = result.value.profiles.find((entry) => entry.profile.profileNumber === 2);

    expect(held?.customer.kind).toBe("linked");
    expect(held?.blockedReason).toBeNull();
    expect(held?.state).toBe("sold");
    expect(held?.remainingDays).toBe(20);
  });

  it("never includes a PIN in the payload", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("nopin");
    const customer = await makeCustomer("nopin");
    await allocate(account.id, 1, customer, { soldDaysAgo: 1, expiresInDays: 30 });
    await sql!`update profiles set pin = '1234' where account_id = ${account.id}::uuid`;

    const result = await quickRenewService.preview(
      { accountEmail: account.email },
      { actor: admin },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(JSON.stringify(result.value)).not.toContain("1234");
    for (const entry of result.value.profiles) {
      expect("pin" in entry.profile).toBe(false);
    }
  });

  it("refuses an email with no live account, on the field the operator typed", async () => {
    const { quickRenewService } = await services();

    const result = await quickRenewService.preview(
      { accountEmail: "nobody@example.invalid" },
      { actor: admin },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    /*
     * A ValidationError, because the message has to render on the input the
     * operator typed. `fieldErrors` lives on that subclass rather than on
     * AppError, so the narrowing is the assertion.
     */
    expect(result.error).toBeInstanceOf(ValidationError);
    expect(
      result.error instanceof ValidationError ? result.error.fieldErrors?.["accountEmail"] : null,
    ).toBeTruthy();
  });

  it("refuses a soft-deleted account", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("deleted");
    await sql!`update accounts set deleted_at = now(), status = 'deleted' where id = ${account.id}::uuid`;

    const result = await quickRenewService.preview(
      { accountEmail: account.email },
      { actor: admin },
    );

    expect(result.ok).toBe(false);
  });

  it("writes nothing at all", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("readonly");
    const customer = await makeCustomer("readonly");
    const profileId = await allocate(account.id, 3, customer, {
      soldDaysAgo: 5,
      expiresInDays: 25,
    });

    const before = await profileRow(profileId);

    await quickRenewService.preview({ accountEmail: account.email }, { actor: admin });
    await quickRenewService.quote({ profileId, duration: preset("3_months") }, { actor: admin });

    expect(await profileRow(profileId)).toEqual(before);
    expect(await eventsFor(profileId)).toHaveLength(1); /* the `created` event only */
    expect(await renewalAudits(profileId)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------ authorization */

describe.skipIf(!local)("authorization is enforced in the service", () => {
  it("allows a Worker to renew", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("worker-ok");
    const customer = await makeCustomer("worker-ok");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 5,
      expiresInDays: 25,
    });

    const result = await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: customer,
        expectedExpirationDate: await dateIn(25),
        duration: custom(30),
        operationId: randomUUID(),
      },
      { actor: worker },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
  });

  it("refuses a role without the permission, and writes nothing", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("role-denied");
    const customer = await makeCustomer("role-denied");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 5,
      expiresInDays: 25,
    });

    /*
     * A role string the permission matrix does not grant RENEW_SUBSCRIPTIONS.
     * Cast because `UserRole` is a closed union — which is the point: the only
     * way to reach this branch is to lie about the role, exactly as a crafted
     * request would.
     */
    const stranger = { ...worker, role: "viewer" as AppUser["role"] };
    const expected = await dateIn(25);

    const denied = await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: customer,
        expectedExpirationDate: expected,
        duration: custom(30),
        operationId: randomUUID(),
      },
      { actor: stranger },
    );

    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("FORBIDDEN");

    /* And the READ is refused too — no account enumeration through the lookup. */
    const lookup = await quickRenewService.preview(
      { accountEmail: account.email },
      { actor: stranger },
    );

    expect(lookup.ok).toBe(false);

    const quoted = await quickRenewService.quote(
      { profileId, duration: custom(30) },
      { actor: stranger },
    );

    expect(quoted.ok).toBe(false);

    const row = await profileRow(profileId);
    expect(row.expiration_date).toBe(expected);
  });

  it("refuses a request with no signed-in actor", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("no-actor");

    const result = await quickRenewService.preview(
      { accountEmail: account.email },
      { actor: null },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FORBIDDEN");
  });
});

/* -------------------------------------------------------------- the renewal */

describe.skipIf(!local)("renewing a live subscription", () => {
  it("extends from the current expiry and records the whole story", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("extend");
    const customer = await makeCustomer("extend");
    const profileId = await allocate(account.id, 2, customer, {
      soldDaysAgo: 10,
      expiresInDays: 20,
    });

    const previousExpiry = await dateIn(20);
    const expectedNewExpiry = await dateIn(50);

    const result = await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: customer,
        expectedExpirationDate: previousExpiry,
        duration: custom(30),
        operationId: randomUUID(),
      },
      { actor: admin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.basis).toBe("current_expiry");
    expect(result.value.previousExpirationDate).toBe(previousExpiry);
    expect(result.value.expirationDate).toBe(expectedNewExpiry);
    expect(result.value.addedDays).toBe(30);
    expect(result.value.replayed).toBe(false);

    /* The row says the same thing the response said. */
    const row = await profileRow(profileId);

    expect(row.expiration_date).toBe(expectedNewExpiry);
    expect(row.status).toBe("sold");
    expect(row.customer_id).toBe(customer);
    expect(row.worker_id).toBe(admin.id);
    /* The sale date is history and does not move; the duration is the whole span. */
    expect(row.sale_date).toBe(await dateIn(-10));
    expect(row.duration_days).toBe(60);

    /* History: M09 §10. */
    const events = await eventsFor(profileId);
    const renewal = events.at(-1)!;

    expect(renewal.event_type).toBe("extended");
    expect(renewal.user_id).toBe(admin.id);
    expect(renewal.metadata["source"]).toBe("quick_renew");
    expect(renewal.metadata["basis"]).toBe("current_expiry");
    expect(renewal.metadata["renewalDays"]).toBe(30);
    expect(renewal.metadata["from"]).toMatchObject({ expirationDate: previousExpiry });
    expect(renewal.metadata["to"]).toMatchObject({ expirationDate: expectedNewExpiry });

    /* Audit: M09 §19. */
    const audits = await renewalAudits(profileId);

    expect(audits).toHaveLength(1);
    expect(audits[0]!.before["expirationDate"]).toBe(previousExpiry);
    expect(audits[0]!.after["expirationDate"]).toBe(expectedNewExpiry);
    expect(audits[0]!.after["renewalDays"]).toBe(30);
    expect(audits[0]!.after["customerId"]).toBe(customer);
    expect(audits[0]!.after["accountId"]).toBe(account.id);
    /* The PIN is never audited, by allow-list. */
    expect(JSON.stringify(audits[0])).not.toContain('pin":"');
  });

  it("renews by calendar months", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("months");
    const customer = await makeCustomer("months");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 10,
    });

    const expected = await dateIn(10);

    const result = await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: customer,
        expectedExpirationDate: expected,
        duration: preset("3_months"),
        operationId: randomUUID(),
      },
      { actor: admin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    /* Three calendar months on from the old expiry, as the database agrees. */
    const months = await sql!<{ d: string }[]>`
      select ((current_date + 10) + interval '3 months')::date::text as d`;

    expect(result.value.expirationDate).toBe(months[0]!.d);
    expect(result.value.renewalLabel).toBe("3 months");
  });

  it("renewing twice extends twice, each from the latest expiry", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("twice");
    const customer = await makeCustomer("twice");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 10,
    });

    const first = await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: customer,
        expectedExpirationDate: await dateIn(10),
        duration: custom(10),
        operationId: randomUUID(),
      },
      { actor: admin },
    );

    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: customer,
        expectedExpirationDate: first.value.expirationDate,
        duration: custom(10),
        operationId: randomUUID(),
      },
      { actor: admin },
    );

    expect(second.ok, second.ok ? "" : second.error.message).toBe(true);
    if (!second.ok) return;

    expect(second.value.expirationDate).toBe(await dateIn(30));

    /* Both renewals are in the history. Nothing was overwritten. */
    const extended = (await eventsFor(profileId)).filter(
      (event) => event.event_type === "extended",
    );

    expect(extended).toHaveLength(2);
    expect(await renewalAudits(profileId)).toHaveLength(2);
  });
});

describe.skipIf(!local)("renewing a lapsed subscription", () => {
  it("starts a new term today rather than extending a date in the past", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("lapsed");
    const customer = await makeCustomer("lapsed");
    const profileId = await allocate(account.id, 2, customer, {
      soldDaysAgo: 60,
      expiresInDays: -30,
    });

    const previousExpiry = await dateIn(-30);

    const result = await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: customer,
        expectedExpirationDate: previousExpiry,
        duration: custom(30),
        operationId: randomUUID(),
      },
      { actor: admin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.basis).toBe("today");
    expect(result.value.previousExpirationDate).toBe(previousExpiry);
    expect(result.value.expirationDate).toBe(await dateIn(30));

    const row = await profileRow(profileId);

    /* A fresh term: the sale date moves to today and the duration is its length. */
    expect(row.sale_date).toBe(await dateIn(0));
    expect(row.duration_days).toBe(30);
    expect(row.expiration_date).toBe(await dateIn(30));
  });
});

/* ------------------------------------------------------------- the refusals */

describe.skipIf(!local)("what cannot be renewed", () => {
  it("refuses a profile nobody holds", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("free");

    const rows = await sql!<{ id: string }[]>`
      select id from profiles where account_id = ${account.id}::uuid and profile_number = 4`;

    const quoted = await quickRenewService.quote(
      { profileId: rows[0]!.id, duration: custom(30) },
      { actor: admin },
    );

    expect(quoted.ok).toBe(false);
    if (quoted.ok) return;
    expect(quoted.error.userMessage).toContain("Quick Prepare");
  });

  it("refuses every profile on an account with a blocking problem", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("problem");
    const customer = await makeCustomer("problem");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });

    await sql!`insert into issues (account_id, issue_type, status, severity, description, reported_by)
               values (${account.id}::uuid, 'payment_problem', 'open', 'high',
                       ${"m09 fixture problem"}, ${admin.id}::uuid)`;

    const lookup = await quickRenewService.preview(
      { accountEmail: account.email },
      { actor: admin },
    );

    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.value.accountBlocksRenewal).toBe(true);
    expect(
      lookup.value.profiles.every((entry) => entry.blockedReason === "account_unavailable"),
    ).toBe(true);

    const confirmed = await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: customer,
        expectedExpirationDate: await dateIn(30),
        duration: custom(30),
        operationId: randomUUID(),
      },
      { actor: admin },
    );

    expect(confirmed.ok).toBe(false);
    if (confirmed.ok) return;
    expect(confirmed.error.userMessage).toContain("Quick Replace");
    expect((await profileRow(profileId)).expiration_date).toBe(await dateIn(30));
  });

  it("refuses a renewal that would outlive the account's own validity", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("validity", { validUntil: await dateIn(40) });
    const customer = await makeCustomer("validity");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });

    const quoted = await quickRenewService.quote(
      { profileId, duration: custom(60) },
      { actor: admin },
    );

    expect(quoted.ok).toBe(false);
    if (quoted.ok) return;
    expect(quoted.error.userMessage).toContain("cannot outlive the account");

    /* A renewal that fits is still allowed. */
    const fits = await quickRenewService.quote(
      { profileId, duration: custom(5) },
      { actor: admin },
    );

    expect(fits.ok, fits.ok ? "" : fits.error.message).toBe(true);
  });

  it("refuses a slot above the account's sellable count", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("parked", { profileSlots: 2 });
    const customer = await makeCustomer("parked");
    const profileId = await allocate(account.id, 5, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });

    const quoted = await quickRenewService.quote(
      { profileId, duration: custom(30) },
      { actor: admin },
    );

    expect(quoted.ok).toBe(false);
    if (quoted.ok) return;
    expect(quoted.error.userMessage).toContain("sellable slots");
  });

  it("refuses a blocked customer", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("blocked");
    const customer = await makeCustomer("blocked");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });

    await sql!`update customers set blocked_at = now() where id = ${customer}::uuid`;

    const quoted = await quickRenewService.quote(
      { profileId, duration: custom(30) },
      { actor: admin },
    );

    expect(quoted.ok).toBe(false);
    if (quoted.ok) return;
    expect(quoted.error.userMessage).toContain("blocked");
  });

  it("refuses an invalid duration without touching the row", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("baddur");
    const customer = await makeCustomer("baddur");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });

    for (const days of [0, -1, 30.5, 10_000]) {
      const quoted = await quickRenewService.quote(
        { profileId, duration: custom(days) },
        { actor: admin },
      );

      expect(quoted.ok).toBe(false);
    }

    expect((await profileRow(profileId)).expiration_date).toBe(await dateIn(30));
  });

  it("refuses a profile that does not exist", async () => {
    const { quickRenewService } = await services();

    const quoted = await quickRenewService.quote(
      { profileId: randomUUID(), duration: custom(30) },
      { actor: admin },
    );

    expect(quoted.ok).toBe(false);
    if (quoted.ok) return;
    expect(quoted.error.code).toBe("NOT_FOUND");
  });
});

/* ------------------------------------------------------- idempotency & races */

describe.skipIf(!local)("one renewal per confirmation", () => {
  it("the same confirmation sent twice renews once and replays the first result", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("idem");
    const customer = await makeCustomer("idem");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });

    const request = {
      profileId,
      accountId: account.id,
      customerId: customer,
      expectedExpirationDate: await dateIn(30),
      duration: custom(30),
      operationId: randomUUID(),
    };

    const first = await quickRenewService.confirm(request, { actor: admin });
    const second = await quickRenewService.confirm(request, { actor: admin });

    expect(first.ok, first.ok ? "" : first.error.message).toBe(true);
    expect(second.ok, second.ok ? "" : second.error.message).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.value.replayed).toBe(false);
    expect(second.value.replayed).toBe(true);
    expect(second.value.expirationDate).toBe(first.value.expirationDate);

    /* Renewed ONCE: one event, one audit entry, one expiry move. */
    const extended = (await eventsFor(profileId)).filter((e) => e.event_type === "extended");

    expect(extended).toHaveLength(1);
    expect(await renewalAudits(profileId)).toHaveLength(1);
    expect((await profileRow(profileId)).expiration_date).toBe(await dateIn(60));
  });

  it("three copies of one confirmation at once still renew once", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("burst");
    const customer = await makeCustomer("burst");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });

    const request = {
      profileId,
      accountId: account.id,
      customerId: customer,
      expectedExpirationDate: await dateIn(30),
      duration: custom(30),
      operationId: randomUUID(),
    };

    const outcomes = await Promise.all([
      quickRenewService.confirm(request, { actor: admin }),
      quickRenewService.confirm(request, { actor: admin }),
      quickRenewService.confirm(request, { actor: admin }),
    ]);

    const succeeded = outcomes.filter((outcome) => outcome.ok);

    expect(succeeded).toHaveLength(3);

    const performed = succeeded.filter((outcome) => outcome.ok && !outcome.value.replayed);

    expect(performed).toHaveLength(1);
    expect((await eventsFor(profileId)).filter((e) => e.event_type === "extended")).toHaveLength(1);
    expect((await profileRow(profileId)).expiration_date).toBe(await dateIn(60));
  });

  it("writes a receipt holding references and dates, never a credential", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("receipt");
    const customer = await makeCustomer("receipt");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });
    const operationId = randomUUID();

    await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: customer,
        expectedExpirationDate: await dateIn(30),
        duration: custom(30),
        operationId,
      },
      { actor: admin },
    );

    const rows = await receipts(operationId);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(admin.id);
    expect(rows[0]!.result).toMatchObject({ profileId, customerId: customer, addedDays: 30 });
    expect(JSON.stringify(rows[0]!.result)).not.toContain(PLAINTEXT);
  });

  it("refuses an operation id reused for a DIFFERENT renewal", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("reuse");
    const customer = await makeCustomer("reuse");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });
    const operationId = randomUUID();
    const expected = await dateIn(30);

    const first = await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: customer,
        expectedExpirationDate: expected,
        duration: custom(30),
        operationId,
      },
      { actor: admin },
    );

    expect(first.ok).toBe(true);

    /* Same key, different duration. Replaying the first would be wrong. */
    const mismatched = await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: customer,
        expectedExpirationDate: expected,
        duration: custom(90),
        operationId,
      },
      { actor: admin },
    );

    expect(mismatched.ok).toBe(false);
    if (mismatched.ok) return;
    expect(mismatched.error.code).toBe("CONFLICT");
  });

  it("refuses one operator's confirmation id used by another", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("actor");
    const customer = await makeCustomer("actor");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });
    const operationId = randomUUID();
    const request = {
      profileId,
      accountId: account.id,
      customerId: customer,
      expectedExpirationDate: await dateIn(30),
      duration: custom(30),
      operationId,
    };

    expect((await quickRenewService.confirm(request, { actor: admin })).ok).toBe(true);

    const stolen = await quickRenewService.confirm(request, { actor: worker });

    expect(stolen.ok).toBe(false);
    if (stolen.ok) return;
    expect(stolen.error.code).toBe("CONFLICT");
  });
});

describe.skipIf(!local)("two operators on the same profile", () => {
  it("renews once: the second is refused because the expiry it quoted has moved", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("race");
    const customer = await makeCustomer("race");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });

    /* Both operators opened the profile and were shown the same expiry. */
    const quoted = await dateIn(30);

    const base = {
      profileId,
      accountId: account.id,
      customerId: customer,
      expectedExpirationDate: quoted,
      duration: custom(30),
    };

    const first = await quickRenewService.confirm(
      { ...base, operationId: randomUUID() },
      { actor: admin },
    );
    const second = await quickRenewService.confirm(
      { ...base, operationId: randomUUID() },
      { actor: worker },
    );

    expect(first.ok, first.ok ? "" : first.error.message).toBe(true);
    expect(second.ok).toBe(false);
    if (!first.ok || second.ok) return;

    expect(second.error.code).toBe("CONFLICT");
    expect(second.error.userMessage).toContain("changed while you were reviewing");

    /* 30 days added, not 60. */
    expect((await profileRow(profileId)).expiration_date).toBe(await dateIn(60));
    expect((await eventsFor(profileId)).filter((e) => e.event_type === "extended")).toHaveLength(1);
  });

  it("refuses both halves of a simultaneous pair beyond the first", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("race2");
    const customer = await makeCustomer("race2");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });

    const base = {
      profileId,
      accountId: account.id,
      customerId: customer,
      expectedExpirationDate: await dateIn(30),
      duration: custom(30),
    };

    const outcomes = await Promise.all([
      quickRenewService.confirm({ ...base, operationId: randomUUID() }, { actor: admin }),
      quickRenewService.confirm({ ...base, operationId: randomUUID() }, { actor: worker }),
      quickRenewService.confirm({ ...base, operationId: randomUUID() }, { actor: admin }),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect((await profileRow(profileId)).expiration_date).toBe(await dateIn(60));
  });

  it("refuses a confirmation naming the wrong customer", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("wrongcus");
    const holder = await makeCustomer("holder");
    const other = await makeCustomer("other");
    const profileId = await allocate(account.id, 1, holder, { soldDaysAgo: 1, expiresInDays: 30 });

    const result = await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: other,
        expectedExpirationDate: await dateIn(30),
        duration: custom(30),
        operationId: randomUUID(),
      },
      { actor: admin },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFLICT");
    expect((await profileRow(profileId)).customer_id).toBe(holder);
  });

  it("refuses a confirmation naming the wrong account", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("wrongacc");
    const decoy = await makeAccount("decoy");
    const customer = await makeCustomer("wrongacc");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });

    const result = await quickRenewService.confirm(
      {
        profileId,
        accountId: decoy.id,
        customerId: customer,
        expectedExpirationDate: await dateIn(30),
        duration: custom(30),
        operationId: randomUUID(),
      },
      { actor: admin },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFLICT");
  });
});

/* ------------------------------------------------------------- the regression */

describe.skipIf(!local)("a renewal leaves the rest of the CRM alone", () => {
  it("does not free the profile, change the customer, or touch a sibling slot", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("neighbours");
    const customer = await makeCustomer("neighbours");
    const neighbour = await makeCustomer("neighbour");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });
    const neighbourId = await allocate(account.id, 2, neighbour, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });

    const before = await profileRow(neighbourId);

    const result = await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: customer,
        expectedExpirationDate: await dateIn(30),
        duration: custom(30),
        operationId: randomUUID(),
      },
      { actor: admin },
    );

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);

    expect(await profileRow(neighbourId)).toEqual(before);

    const renewed = await profileRow(profileId);

    expect(renewed.status).toBe("sold");
    expect(renewed.customer_id).toBe(customer);
  });

  it("records the purchase on the customer, as a sale does", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("purchase");
    const customer = await makeCustomer("purchase");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });

    await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: customer,
        expectedExpirationDate: await dateIn(30),
        duration: custom(30),
        operationId: randomUUID(),
      },
      { actor: admin },
    );

    const rows = await sql!<{ first: Date | null; last: Date | null }[]>`
      select first_purchase_at as first, last_purchase_at as last
      from customers where id = ${customer}::uuid`;

    expect(rows[0]!.first).not.toBeNull();
    expect(rows[0]!.last).not.toBeNull();
  });

  it("is counted as an extension by the Reports module, with no change there", async () => {
    const { quickRenewService } = await services();
    const account = await makeAccount("reports");
    const customer = await makeCustomer("reports");
    const profileId = await allocate(account.id, 1, customer, {
      soldDaysAgo: 1,
      expiresInDays: 30,
    });

    await quickRenewService.confirm(
      {
        profileId,
        accountId: account.id,
        customerId: customer,
        expectedExpirationDate: await dateIn(30),
        duration: custom(30),
        operationId: randomUUID(),
      },
      { actor: admin },
    );

    const rows = await sql!<{ extensions: number }[]>`
      select count(*) filter (where event_type = 'extended')::int as extensions
      from profile_events where profile_id = ${profileId}::uuid`;

    expect(rows[0]!.extensions).toBe(1);
  });
});
