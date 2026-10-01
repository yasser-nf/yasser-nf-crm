import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M08 jobs: Quick Prepare and Quick Replace happen at most once per order,
 * and a job that runs one never sells twice — whatever retries, repeats or
 * crashes in between.
 *
 * Concurrency, honestly: the isolated database runs one transaction at a time,
 * so the "at once" cases below interleave at transaction boundaries. That is
 * exactly the window that matters for a repeat — the second request's checks
 * run before or after the first commits, and both orders must end in one sale.
 * True overlap inside the receipt's unique index (the second INSERT waiting on
 * the first) rests on PostgreSQL semantics, documented in JOBS_MODULE.md.
 *
 * LOCAL ONLY.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;
const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

const PREFIX = "m08-idem";
const PLAINTEXT = "m08-not-a-real-password";

let admin: AppUser;
let worker: AppUser;

async function services() {
  const quick = await import("@/modules/quick-prepare");
  const { accountsService } = await import("@/modules/accounts");
  const jobs = await import("@/modules/jobs");
  const { ok } = await import("@/utils/result");
  return { ...quick, accountsService, ...jobs, ok };
}

function phone(): string {
  return `+21366${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;
}

async function makeAccount(tag: string): Promise<{ id: string; email: string }> {
  const { accountsService } = await services();
  const email = `${PREFIX}-${tag}-${randomUUID().slice(0, 8)}@example.invalid`;
  const created = await accountsService.createAccount(
    { email, password: PLAINTEXT, country: "DZ", profileSlots: 5 },
    { actor: admin },
  );
  if (!created.ok) throw new Error(created.error.message);
  return { id: created.value.id, email };
}

/** Profiles sold to the customer behind this phone, and their sale events. */
async function saleCounts(customerPhone: string) {
  const digits = customerPhone.replace(/\D/g, "").slice(-9);
  const [counts] = await sql!<{ profiles: number; events: number; audits: number }[]>`
    select
      (select count(*)::int from profiles p join customers c on c.id = p.customer_id
        where c.phone_normalized like ${`%${digits}`} and p.status = 'sold') as profiles,
      (select count(*)::int from profile_events e join customers c on c.id = e.customer_id
        where c.phone_normalized like ${`%${digits}`} and e.event_type = 'sold') as events,
      (select count(*)::int from audit_logs a
        where a.after->>'event' = 'quick_prepare_allocation'
          and a.after->>'customerId' in (select id::text from customers where phone_normalized like ${`%${digits}`})) as audits`;
  return counts!;
}

async function receipt(scope: string, key: string) {
  const [found] = await sql!<{ result: Record<string, unknown> | null; actor_id: string | null }[]>`
    select result, actor_id from idempotency_keys where scope = ${scope} and key = ${key}`;
  return found ?? null;
}

beforeAll(async () => {
  if (!local) return;
  const [a] = await sql!<{ id: string; name: string; email: string }[]>`
    select id, name, email from users where role = 'super_admin' and deleted_at is null limit 1`;
  const [w] = await sql!<{ id: string; name: string; email: string }[]>`
    select id, name, email from users where role = 'worker' and deleted_at is null limit 1`;
  admin = { id: a!.id, email: a!.email, displayName: a!.name, initials: "SA", role: "super_admin" };
  worker = { id: w!.id, email: w!.email, displayName: w!.name, initials: "W", role: "worker" };

  /* Stock of our own, so these tests never depend on the seed's. */
  for (let index = 0; index < 4; index += 1) await makeAccount(`stock${index}`);
});

afterEach(async () => {
  if (!local) return;
  await sql!`update accounts set deleted_at = null where email like ${`${PREFIX}-%`}`;
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/* ------------------------------------------------------------ Quick Prepare */

describe.skipIf(!local)("Quick Prepare: one sale per order", () => {
  it("the same order confirmed twice sells once and replays the first result", async () => {
    const { quickPrepareService, QUICK_PREPARE_SCOPE } = await services();
    const customer = phone();
    const operationId = randomUUID();
    const order = { profileCount: 2, durationDays: 30, phone: customer, operationId };

    const first = await quickPrepareService.confirm(order, { actor: admin });
    const second = await quickPrepareService.confirm(order, { actor: admin });

    expect(first.ok, first.ok ? "" : first.error.message).toBe(true);
    expect(second.ok, second.ok ? "" : second.error.message).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.value.replayed).toBe(false);
    expect(second.value.replayed).toBe(true);
    expect(second.value.accounts).toEqual(first.value.accounts);
    expect(second.value.clipboardText).toBe(first.value.clipboardText);
    expect(second.value.customerIsNew).toBe(first.value.customerIsNew);
    expect(second.value.expirationDate).toBe(first.value.expirationDate);

    expect(await saleCounts(customer)).toEqual({
      profiles: 2,
      events: 2,
      audits: first.value.accounts.length,
    });

    /* The receipt holds references only — never the password or a PIN. */
    const stored = await receipt(QUICK_PREPARE_SCOPE, operationId);
    expect(stored?.actor_id).toBe(admin.id);
    expect(JSON.stringify(stored)).not.toContain(PLAINTEXT);
    expect(Object.keys(stored?.result ?? {}).sort()).toEqual([
      "accounts",
      "customerId",
      "customerIsNew",
      "durationDays",
      "expirationDate",
      "requiresPasswordChange",
    ]);
  });

  it("three copies of one order at once still sell once", async () => {
    const { quickPrepareService } = await services();
    const { customersService } = await import("@/modules/customers");
    const customer = phone();
    const order = { profileCount: 1, durationDays: 30, phone: customer, operationId: randomUUID() };

    /*
     * The customer exists first, so this test is about the ORDER key alone.
     * Three concurrent first-ever purchases for a brand-new phone exercise the
     * customer find-or-create race instead — pre-M08 code, and the harness's
     * socket multiplexer is not reliable for overlapping untransacted
     * statements (see JOBS_MODULE.md §12).
     */
    await customersService.findOrCreateByPhone(customer);

    const results = await Promise.all(
      [1, 2, 3].map(() => quickPrepareService.confirm(order, { actor: admin })),
    );

    for (const result of results)
      expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    const values = results.flatMap((result) => (result.ok ? [result.value] : []));
    expect(values.filter((value) => !value.replayed)).toHaveLength(1);
    expect(new Set(values.map((value) => value.accounts[0]?.profiles[0]?.profileId)).size).toBe(1);
    expect((await saleCounts(customer)).profiles).toBe(1);
  });

  it("refuses the same key for a different order, or from someone else", async () => {
    const { quickPrepareService } = await services();
    const customer = phone();
    const operationId = randomUUID();
    await quickPrepareService.confirm(
      { profileCount: 1, durationDays: 30, phone: customer, operationId },
      { actor: admin },
    );

    const otherOrder = await quickPrepareService.confirm(
      { profileCount: 2, durationDays: 30, phone: customer, operationId },
      { actor: admin },
    );
    const otherActor = await quickPrepareService.confirm(
      { profileCount: 1, durationDays: 30, phone: customer, operationId },
      { actor: worker },
    );

    for (const refused of [otherOrder, otherActor]) {
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("CONFLICT");
    }
    expect((await saleCounts(customer)).profiles).toBe(1);
  });

  it("a different order is a different sale — repeat purchases still work", async () => {
    const { quickPrepareService } = await services();
    const customer = phone();
    const order = { profileCount: 1, durationDays: 30, phone: customer };

    const one = await quickPrepareService.confirm(
      { ...order, operationId: randomUUID() },
      { actor: admin },
    );
    const two = await quickPrepareService.confirm(
      { ...order, operationId: randomUUID() },
      { actor: admin },
    );
    /* Server code without an id: each call is its own operation. */
    const three = await quickPrepareService.confirm(order, { actor: admin });

    for (const result of [one, two, three]) expect(result.ok && result.value.replayed).toBe(false);
    expect((await saleCounts(customer)).profiles).toBe(3);
  });

  it("a replay refuses once the allocation has moved on, and sells nothing new", async () => {
    const { quickPrepareService } = await services();
    const customer = phone();
    const order = { profileCount: 1, durationDays: 30, phone: customer, operationId: randomUUID() };
    const first = await quickPrepareService.confirm(order, { actor: admin });
    if (!first.ok) throw new Error(first.error.message);

    /* The sale is undone afterwards (an unassignment, a replacement…). */
    const profileId = first.value.accounts[0]!.profiles[0]!.profileId;
    await sql!`update profiles set status = 'available', customer_id = null, worker_id = null,
               sale_date = null, expiration_date = null, duration_days = null where id = ${profileId}::uuid`;

    const replay = await quickPrepareService.confirm(order, { actor: admin });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.error.code).toBe("CONFLICT");
      expect(replay.error.userMessage).toMatch(/already completed/);
      expect(JSON.stringify(replay)).not.toContain(PLAINTEXT);
    }
    expect((await saleCounts(customer)).profiles).toBe(0);
  });

  it("a failed attempt leaves no receipt, so the same order can be retried once stock exists", async () => {
    const { quickPrepareService, QUICK_PREPARE_SCOPE } = await services();
    const operationId = randomUUID();
    const order = { profileCount: 1, durationDays: 30, phone: phone(), operationId };

    /* No stock at all: the transaction refuses and rolls back. */
    const live = await sql!<{ id: string }[]>`
      update accounts set deleted_at = now() where deleted_at is null returning id`;

    let refused;
    try {
      refused = await quickPrepareService.confirm(order, { actor: admin });
    } finally {
      await sql!`update accounts set deleted_at = null where id in ${sql!(live.map((entry) => entry.id))}`;
    }

    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("VALIDATION_ERROR");
    expect(await receipt(QUICK_PREPARE_SCOPE, operationId)).toBeNull();

    /* Stock is back: the very same order (same key) now goes through, once. */
    const retried = await quickPrepareService.confirm(order, { actor: admin });
    expect(retried.ok && retried.value.replayed).toBe(false);
    expect(await receipt(QUICK_PREPARE_SCOPE, operationId)).not.toBeNull();
  });

  it("two different orders for the last profile: exactly one gets it", async () => {
    const { quickPrepareService } = await services();
    const last = await makeAccount("last");

    /* Everything else out of stock for this test (restored afterwards). */
    await sql!`update accounts set deleted_at = now() where id <> ${last.id}::uuid and deleted_at is null and email like ${`${PREFIX}-%`}`;
    const seedStock = await sql!<{ id: string }[]>`
      update accounts set deleted_at = now() where id <> ${last.id}::uuid and deleted_at is null returning id`;
    await sql!`update profiles set status = 'sold', customer_id = (select id from customers limit 1),
               sale_date = current_date, expiration_date = current_date + 300, duration_days = 300
               where account_id = ${last.id}::uuid and profile_number > 1`;

    try {
      const [a, b] = await Promise.all([
        quickPrepareService.confirm(
          { profileCount: 1, durationDays: 30, phone: phone(), operationId: randomUUID() },
          { actor: admin },
        ),
        quickPrepareService.confirm(
          { profileCount: 1, durationDays: 30, phone: phone(), operationId: randomUUID() },
          { actor: admin },
        ),
      ]);

      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const loser = a.ok ? b : a;
      if (!loser.ok) expect(loser.error.code).toBe("VALIDATION_ERROR");

      const [{ owners } = { owners: -1 }] = await sql!<{ owners: number }[]>`
        select count(distinct customer_id)::int owners from profiles
        where account_id = ${last.id}::uuid and profile_number = 1 and status = 'sold'`;
      expect(owners).toBe(1);
    } finally {
      if (seedStock.length > 0) {
        await sql!`update accounts set deleted_at = null where id in ${sql!(seedStock.map((entry) => entry.id))}`;
      }
    }
  });
});

/* ------------------------------------------------------------ Quick Replace */

describe.skipIf(!local)(
  "Quick Replace: a repeat replays instead of failing or replacing twice",
  () => {
    it("the same replacement confirmed twice moves the customer once and shows the same result", async () => {
      const { quickPrepareService, quickReplaceService } = await services();
      const sold = await quickPrepareService.confirm(
        { profileCount: 1, durationDays: 60, phone: phone(), operationId: randomUUID() },
        { actor: admin },
      );
      if (!sold.ok) throw new Error(sold.error.message);
      const brokenId = sold.value.accounts[0]!.accountId;
      const [broken] = await sql!<
        { email: string }[]
      >`select email from accounts where id = ${brokenId}::uuid`;

      const preview = await quickReplaceService.preview({
        accountEmail: broken!.email,
        customerId: sold.value.customerId,
      });
      if (!preview.ok || !preview.value.replacement || !preview.value.selected) {
        throw new Error("no replacement available");
      }

      const input = {
        accountId: brokenId,
        customerId: sold.value.customerId,
        expectedProfileIds: preview.value.selected.profiles.map((profile) => profile.id),
        replacementAccountId: preview.value.replacement.account.id,
        reason: "m08",
        passwordChangeConfirmed: true,
        operationId: randomUUID(),
      };

      const first = await quickPrepareService.confirmReplacement(input, { actor: admin });
      const second = await quickPrepareService.confirmReplacement(input, { actor: admin });

      expect(first.ok, first.ok ? "" : first.error.message).toBe(true);
      expect(second.ok, second.ok ? "" : second.error.message).toBe(true);
      if (!first.ok || !second.ok) return;

      expect(second.value.replayed).toBe(true);
      expect(second.value.accounts).toEqual(first.value.accounts);

      const [counts] = await sql!<{ moved: number; released: number; audits: number }[]>`
      select
        (select count(*)::int from profile_events where customer_id = ${sold.value.customerId}::uuid
           and event_type = 'replaced' and metadata->>'outcome' = 'reallocated') as moved,
        (select count(*)::int from profile_events where customer_id = ${sold.value.customerId}::uuid
           and event_type = 'replaced' and metadata->>'outcome' = 'cancelled') as released,
        (select count(*)::int from audit_logs where after->>'event' = 'quick_prepare_replacement'
           and after->>'customerId' = ${sold.value.customerId}) as audits`;
      expect(counts).toEqual({ moved: 1, released: 1, audits: 1 });

      /* Without the key it is a new request — and it is refused, never a second replacement. */
      const fresh = await quickPrepareService.confirmReplacement(
        { ...input, operationId: randomUUID() },
        { actor: admin },
      );
      expect(fresh.ok).toBe(false);
      if (!fresh.ok) expect(fresh.error.userMessage).toMatch(/changed while you were reviewing/);
    });
  },
);

/* ------------------------------------------------- jobs running business */

describe.skipIf(!local)("a job that sells: no crash, retry or recovery sells twice", () => {
  async function saleJob() {
    const { defineJob, quickPrepareService, QUICK_PREPARE_SCOPE, ok } = await services();
    const payload = z.object({
      operationId: z.uuid(),
      phone: z.string(),
      profileCount: z.number(),
    });

    const run = async (input: z.infer<typeof payload>) =>
      quickPrepareService.confirm({ ...input, durationDays: 30 }, { actor: admin });

    const definition = defineJob({
      type: `test.sale_${randomUUID().slice(0, 8)}`,
      payload,
      receipt: (job) => ({ scope: QUICK_PREPARE_SCOPE, key: job.payload.operationId }),
      async run(context) {
        const sold = await run(context.payload);
        return sold.ok
          ? ok({ customerId: sold.value.customerId, replayed: sold.value.replayed })
          : sold;
      },
    });

    return { definition, run };
  }

  async function enqueueSale(definition: Awaited<ReturnType<typeof saleJob>>["definition"]) {
    const { jobQueue } = await services();
    const order = { operationId: randomUUID(), phone: phone(), profileCount: 2 };
    const created = await jobQueue.enqueue(
      definition,
      { idempotencyKey: order.operationId, payload: order },
      { actor: admin },
    );
    if (!created.ok) throw new Error(created.error.message);
    return { order, jobId: created.value.job.id };
  }

  async function stale(jobId: string) {
    await sql!`update jobs set heartbeat_at = now() - interval '10 minutes' where id = ${jobId}::uuid`;
  }

  it("worker dies AFTER the sale committed: recovery marks the job done and does not sell again", async () => {
    const { jobQueue, createRegistry } = await services();
    const { definition, run } = await saleJob();
    const registry = createRegistry([definition]);
    const { order, jobId } = await enqueueSale(definition);

    const claimed = await jobQueue.claim("w-dies-after", registry);
    if (!claimed.ok || !claimed.value) throw new Error("no claim");
    expect((await run(order)).ok).toBe(true); // the business transaction commits…
    await stale(jobId); // …and the worker vanishes before reporting

    const report = await jobQueue.recoverStale(registry);
    expect(report.ok && report.value).toMatchObject({ completed: 1, requeued: 0 });

    const [job] = await sql!<
      { status: string }[]
    >`select status::text from jobs where id = ${jobId}::uuid`;
    expect(job?.status).toBe("succeeded");
    expect((await saleCounts(order.phone)).profiles).toBe(2);
    expect((await jobQueue.processNext("w-next", registry)).ok).toBe(true);
    expect((await saleCounts(order.phone)).profiles).toBe(2);
  });

  it("worker dies BEFORE the sale: recovery requeues it and the retry sells once", async () => {
    const { jobQueue, createRegistry } = await services();
    const { definition } = await saleJob();
    const registry = createRegistry([definition]);
    const { order, jobId } = await enqueueSale(definition);

    const claimed = await jobQueue.claim("w-dies-before", registry);
    if (!claimed.ok || !claimed.value) throw new Error("no claim");
    await stale(jobId);

    const report = await jobQueue.recoverStale(registry);
    expect(report.ok && report.value).toMatchObject({ requeued: 1 });
    expect((await saleCounts(order.phone)).profiles).toBe(0);

    await sql!`update jobs set available_at = now() - interval '1 second' where id = ${jobId}::uuid`;
    const processed = await jobQueue.processNext("w-retry", registry);
    expect(processed.ok && processed.value).toMatchObject({ outcome: "succeeded", jobId });
    expect((await saleCounts(order.phone)).profiles).toBe(2);
  });

  it("the sale commits but the worker's report is lost: the retry replays, it does not resell", async () => {
    const { jobQueue, createRegistry, JobRetryableError } = await services();
    const { definition, run } = await saleJob();
    const registry = createRegistry([definition]);
    const { order, jobId } = await enqueueSale(definition);

    const claimed = await jobQueue.claim("w-lost-report", registry);
    if (!claimed.ok || !claimed.value) throw new Error("no claim");
    expect((await run(order)).ok).toBe(true);
    /* Reporting success failed transiently; the job is queued for another attempt. */
    await jobQueue.fail(claimed.value, new JobRetryableError("network"));

    await sql!`update jobs set available_at = now() - interval '1 second' where id = ${jobId}::uuid`;
    const processed = await jobQueue.processNext("w-second", registry);
    expect(processed.ok && processed.value).toMatchObject({ outcome: "succeeded", jobId });

    const [job] = await sql!<{ status: string; result: { replayed?: boolean } }[]>`
      select status::text, result from jobs where id = ${jobId}::uuid`;
    expect(job).toMatchObject({ status: "succeeded", result: { replayed: true } });
    expect((await saleCounts(order.phone)).profiles).toBe(2);
  });
});
