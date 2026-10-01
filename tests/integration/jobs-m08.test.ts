import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M08 jobs: the durable queue, against the real schema (all migrations).
 *
 * Every test defines its OWN job types (unique names), and a worker only
 * claims the types it is given — so tests cannot claim each other's jobs.
 *
 * About concurrency: the isolated database runs one transaction at a time
 * (PGlite behind a socket multiplexer). "Simultaneous" calls below therefore
 * interleave at statement/transaction boundaries rather than truly overlap.
 * They prove the OUTCOME — exactly one owner, one receipt — under that
 * interleaving; row-lock contention itself (SKIP LOCKED skipping a row
 * another claim holds) rests on PostgreSQL's documented semantics.
 *
 * LOCAL ONLY.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;
const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

let admin: AppUser;
let worker: AppUser;

async function modules() {
  const jobs = await import("@/modules/jobs");
  const { ok, fail } = await import("@/utils/result");
  const errors = await import("@/lib/errors");
  return { ...jobs, ok, fail, errors };
}

/** A fresh job type for one test: claims of other tests never see it. */
async function echoType(options: { maxAttempts?: number } = {}) {
  const { defineJob, ok } = await modules();
  return defineJob({
    type: `test.echo_${randomUUID().slice(0, 8)}`,
    payload: z.object({ n: z.number() }),
    /* Writes nothing, so recovery may safely run it again. */
    retryOnStale: "re-running is safe",
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
    async run(context) {
      return ok({ n: context.payload.n });
    },
  });
}

async function row(id: string) {
  const [found] = await sql!<
    {
      status: string;
      attempts: number;
      claim_token: string | null;
      claimed_by: string | null;
      last_error: string | null;
      last_error_code: string | null;
      finished_at: Date | null;
      recovered_at: Date | null;
      available_at: Date;
      result: Record<string, unknown> | null;
    }[]
  >`select status::text, attempts, claim_token, claimed_by, last_error, last_error_code,
           finished_at, recovered_at, available_at, result
    from jobs where id = ${id}::uuid`;
  return found!;
}

/** Makes a queued job claimable now (a retry's backoff, fast-forwarded). */
async function makeAvailable(id: string) {
  await sql!`update jobs set available_at = now() - interval '1 second' where id = ${id}::uuid`;
}

async function audits(id: string) {
  return sql!<{ action: string; event: string | null; user_id: string | null; snapshot: string }[]>`
    select action::text, after->>'event' as event, user_id, coalesce(after::text, '') as snapshot
    from audit_logs where entity = 'job' and entity_id = ${id}::uuid order by created_at`;
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
  await sql?.end({ timeout: 5 });
});

/* ------------------------------------------------------------------ enqueue */

describe.skipIf(!local)("enqueue: once per business operation", () => {
  it("creates the job once; the same key returns the same job, and is audited once", async () => {
    const { jobQueue } = await modules();
    const type = await echoType();
    const key = `op-${randomUUID()}`;

    const first = await jobQueue.enqueue(
      type,
      { idempotencyKey: key, payload: { n: 1 } },
      { actor: admin },
    );
    const again = await jobQueue.enqueue(
      type,
      { idempotencyKey: key, payload: { n: 1 } },
      { actor: admin },
    );
    const [third, fourth] = await Promise.all([
      jobQueue.enqueue(type, { idempotencyKey: key, payload: { n: 1 } }, { actor: admin }),
      jobQueue.enqueue(type, { idempotencyKey: key, payload: { n: 1 } }, { actor: admin }),
    ]);

    expect(first.ok && first.value.created).toBe(true);
    for (const repeat of [again, third, fourth]) {
      expect(repeat.ok && repeat.value.created).toBe(false);
      expect(repeat.ok && repeat.value.job.id).toBe(first.ok && first.value.job.id);
    }

    const [{ n } = { n: 0 }] = await sql!<{ n: number }[]>`
      select count(*)::int n from jobs where type = ${type.type}`;
    expect(n).toBe(1);

    const trail = await audits(first.ok ? first.value.job.id : "");
    expect(trail.map((entry) => entry.action)).toEqual(["create"]);
    expect(trail[0]!.user_id).toBe(admin.id);
  });

  it("refuses the same key with a different payload", async () => {
    const { jobQueue } = await modules();
    const type = await echoType();
    const key = `op-${randomUUID()}`;

    await jobQueue.enqueue(type, { idempotencyKey: key, payload: { n: 1 } }, { actor: admin });
    const different = await jobQueue.enqueue(
      type,
      { idempotencyKey: key, payload: { n: 2 } },
      { actor: admin },
    );

    expect(different.ok).toBe(false);
    if (!different.ok) expect(different.error.code).toBe("CONFLICT");
  });

  it("refuses a payload carrying a credential, and an invalid one, writing nothing", async () => {
    const { jobQueue, defineJob, ok } = await modules();
    const loose = defineJob({
      type: `test.loose_${randomUUID().slice(0, 8)}`,
      payload: z.record(z.string(), z.unknown()),
      retryOnStale: "re-running is safe",
      async run() {
        return ok({});
      },
    });

    for (const payload of [
      { accountId: "a", password: "hunter2" },
      { profile: { pin: "1234" } },
      { encrypted: "v1:aGVsbG8:d29ybGQ:Zm9vYmFy" },
    ]) {
      const result = await jobQueue.enqueue(
        loose,
        { idempotencyKey: randomUUID(), payload },
        { actor: admin },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
    }

    const typed = await echoType();
    const invalid = await jobQueue.enqueue(
      typed,
      { idempotencyKey: randomUUID(), payload: { n: "one" } as unknown as { n: number } },
      { actor: admin },
    );
    expect(invalid.ok).toBe(false);

    const [{ n } = { n: -1 }] = await sql!<{ n: number }[]>`
      select count(*)::int n from jobs where type in (${loose.type}, ${typed.type})`;
    expect(n).toBe(0);
  });

  it("honours a type's required permission: a Worker cannot enqueue a privileged job", async () => {
    const { jobQueue } = await modules();
    const type = await echoType();

    const refused = await jobQueue.enqueue(
      type,
      { idempotencyKey: randomUUID(), payload: { n: 1 } },
      { actor: worker },
      { permission: "manage_jobs" },
    );

    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("FORBIDDEN");
  });
});

/* -------------------------------------------------------------------- claim */

describe.skipIf(!local)("claim: one owner, in a deterministic order", () => {
  it("claims by priority, then availability, then creation, then id", async () => {
    const { jobQueue, createRegistry } = await modules();
    const type = await echoType();
    const registry = createRegistry([type]);
    const enqueue = async (
      n: number,
      priority: "urgent" | "normal" | "low",
      availableAt?: Date,
    ) => {
      const result = await jobQueue.enqueue(
        type,
        { idempotencyKey: `order-${n}-${randomUUID()}`, payload: { n }, priority, availableAt },
        { actor: admin },
      );
      if (!result.ok) throw new Error(result.error.message);
      return result.value.job.id;
    };

    const past = (seconds: number) => new Date(Date.now() - seconds * 1000);
    await enqueue(1, "low", past(300));
    await enqueue(2, "normal", past(100));
    await enqueue(3, "urgent", past(10));
    await enqueue(4, "normal", past(200));
    await enqueue(5, "urgent", past(20));
    await enqueue(6, "normal", new Date(Date.now() + 3_600_000)); // not yet available

    const order: number[] = [];
    for (;;) {
      const claimed = await jobQueue.claim("order-worker", registry);
      if (!claimed.ok) throw new Error(claimed.error.message);
      if (!claimed.value) break;
      order.push(Number(claimed.value.payload["n"]));
    }

    /* urgent (earliest available first), normal (earliest first), low; #6 is not due. */
    expect(order).toEqual([5, 3, 4, 2, 1]);
  });

  it("two workers claiming at once never share a job", async () => {
    const { jobQueue, createRegistry } = await modules();
    const type = await echoType();
    const registry = createRegistry([type]);

    for (let n = 0; n < 3; n += 1) {
      await jobQueue.enqueue(
        type,
        { idempotencyKey: `race-${n}-${randomUUID()}`, payload: { n } },
        { actor: null },
      );
    }

    const claims = await Promise.all(
      ["w1", "w2", "w3", "w4", "w5"].map((id) => jobQueue.claim(id, registry)),
    );

    const owned = claims.flatMap((result) => (result.ok && result.value ? [result.value] : []));
    expect(owned).toHaveLength(3);
    expect(new Set(owned.map((held) => held.jobId)).size).toBe(3);
    expect(new Set(owned.map((held) => held.claimToken)).size).toBe(3);

    const rows = await sql!<{ claimed_by: string; status: string }[]>`
      select claimed_by, status::text from jobs where type = ${type.type}`;
    expect(rows.every((entry) => entry.status === "running")).toBe(true);
    expect(rows.map((entry) => entry.claimed_by).sort()).toEqual(
      owned.map((held) => held.workerId).sort(),
    );
  });

  it("a worker cannot heartbeat, complete or fail another worker's job", async () => {
    const { jobQueue, createRegistry } = await modules();
    const type = await echoType();
    const registry = createRegistry([type]);
    await jobQueue.enqueue(
      type,
      { idempotencyKey: randomUUID(), payload: { n: 1 } },
      { actor: null },
    );

    const claimed = await jobQueue.claim("worker-a", registry);
    if (!claimed.ok || !claimed.value) throw new Error("no claim");
    const held = claimed.value;
    const impostor = { ...held, workerId: "worker-b", claimToken: randomUUID() };

    for (const attempt of [
      await jobQueue.heartbeat(impostor),
      await jobQueue.complete(impostor, { stolen: true }),
      await jobQueue.fail(impostor, new Error("x")),
    ]) {
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.error.code).toBe("CONFLICT");
    }

    const after = await row(held.jobId);
    expect(after).toMatchObject({
      status: "running",
      claimed_by: "worker-a",
      claim_token: held.claimToken,
    });

    expect((await jobQueue.heartbeat(held)).ok).toBe(true);
  });

  it("claims nothing for an empty registry, and refuses a malformed worker id", async () => {
    const { jobQueue, createRegistry } = await modules();
    const idle = await jobQueue.claim("w", createRegistry([]));
    expect(idle.ok && idle.value).toBeNull();
    expect(
      (await jobQueue.claim("bad id with spaces", createRegistry([await echoType()]))).ok,
    ).toBe(false);
  });
});

/* ----------------------------------------------------- complete / fail / retry */

describe.skipIf(!local)("finishing: complete, retry with backoff, fail", () => {
  it("complete stores safe metadata, releases the claim, and is harmless to repeat", async () => {
    const { jobQueue, createRegistry } = await modules();
    const type = await echoType();
    await jobQueue.enqueue(
      type,
      { idempotencyKey: randomUUID(), payload: { n: 7 } },
      { actor: null },
    );
    const claimed = await jobQueue.claim("w", createRegistry([type]));
    if (!claimed.ok || !claimed.value) throw new Error("no claim");

    const done = await jobQueue.complete(claimed.value, { n: 7 });
    expect(done.ok).toBe(true);
    expect(await row(claimed.value.jobId)).toMatchObject({
      status: "succeeded",
      claim_token: null,
      result: { n: 7 },
    });

    /* The same completion again — a lost acknowledgement, retried. */
    expect((await jobQueue.complete(claimed.value, { n: 7 })).ok).toBe(true);
    expect((await jobQueue.complete(claimed.value, { password: "x" })).ok).toBe(false);

    const trail = await audits(claimed.value.jobId);
    expect(trail.map((entry) => entry.event)).toEqual([null, "job_succeeded"]);
  });

  it("a retryable failure queues it again after a backoff, until attempts run out", async () => {
    const { jobQueue, createRegistry, JobRetryableError } = await modules();
    const type = await echoType({ maxAttempts: 3 });
    const registry = createRegistry([type]);
    const created = await jobQueue.enqueue(
      type,
      { idempotencyKey: randomUUID(), payload: { n: 1 } },
      { actor: null },
    );
    if (!created.ok) throw new Error("enqueue");
    const id = created.value.job.id;

    const delays: number[] = [];

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await jobQueue.claim("w", registry);
      if (!claimed.ok || !claimed.value) throw new Error(`no claim on attempt ${attempt}`);
      expect(claimed.value.attempt).toBe(attempt);

      const before = Date.now();
      const failed = await jobQueue.fail(claimed.value, new JobRetryableError("timeout"));
      if (!failed.ok) throw new Error(failed.error.message);

      if (attempt < 3) {
        expect(failed.value.status).toBe("queued");
        delays.push(Math.round((failed.value.availableAt.getTime() - before) / 1000));
        /* Not claimable during the backoff. */
        expect(
          (await jobQueue.claim("w", registry)).ok && (await jobQueue.claim("w", registry)),
        ).toMatchObject({ ok: true, value: null });
        await makeAvailable(id);
      } else {
        expect(failed.value.status).toBe("failed");
      }
    }

    expect(delays[0]).toBeGreaterThanOrEqual(29);
    expect(delays[0]).toBeLessThanOrEqual(31);
    expect(delays[1]).toBeGreaterThanOrEqual(59);
    expect(delays[1]).toBeLessThanOrEqual(61);

    expect(await row(id)).toMatchObject({
      status: "failed",
      attempts: 3,
      last_error_code: "JOB_RETRYABLE",
    });
    expect((await audits(id)).map((entry) => entry.event)).toEqual([null, "job_failed"]);
  });

  it("a permanent failure fails at once, storing only a safe summary", async () => {
    const { jobQueue, createRegistry, errors } = await modules();
    const type = await echoType();
    const registry = createRegistry([type]);

    await jobQueue.enqueue(
      type,
      { idempotencyKey: randomUUID(), payload: { n: 1 } },
      { actor: null },
    );
    const first = await jobQueue.claim("w", registry);
    if (!first.ok || !first.value) throw new Error("no claim");
    await jobQueue.fail(
      first.value,
      new errors.ValidationError("profile already sold", {
        userMessage: "That profile is already sold.",
      }),
    );
    expect(await row(first.value.jobId)).toMatchObject({
      status: "failed",
      attempts: 1,
      last_error_code: "VALIDATION_ERROR",
      last_error: "That profile is already sold.",
    });

    /* A defect whose message carries a PIN and a key: neither is stored. */
    await jobQueue.enqueue(
      type,
      { idempotencyKey: randomUUID(), payload: { n: 2 } },
      { actor: null },
    );
    const second = await jobQueue.claim("w", registry);
    if (!second.ok || !second.value) throw new Error("no claim");
    await jobQueue.fail(
      second.value,
      new Error("decrypt failed: PIN 4321, key sk_live_abcdef123456"),
    );

    const stored = await row(second.value.jobId);
    expect(stored.status).toBe("failed");
    expect(stored.last_error_code).toBe("UNEXPECTED_ERROR");
    expect(JSON.stringify(stored)).not.toMatch(/4321|sk_live/);
    const trail = await audits(second.value.jobId);
    expect(trail.map((entry) => entry.snapshot).join("|")).not.toMatch(/4321|sk_live/);
  });

  it("processNext runs a job end to end, and idles when there is nothing to do", async () => {
    const { jobQueue, createRegistry, defineJob, JobRetryableError, fail } = await modules();
    const echo = await echoType();
    const flaky = defineJob({
      type: `test.flaky_${randomUUID().slice(0, 8)}`,
      payload: z.object({}),
      retryOnStale: "re-running is safe",
      async run() {
        return fail(new JobRetryableError("try later"));
      },
    });
    const throwing = defineJob({
      type: `test.throws_${randomUUID().slice(0, 8)}`,
      payload: z.object({}),
      retryOnStale: "re-running is safe",
      async run(): Promise<never> {
        throw new Error("boom with PIN 9876");
      },
    });

    await jobQueue.enqueue(
      echo,
      { idempotencyKey: randomUUID(), payload: { n: 3 } },
      { actor: null },
    );
    await jobQueue.enqueue(flaky, { idempotencyKey: randomUUID(), payload: {} }, { actor: null });
    await jobQueue.enqueue(
      throwing,
      { idempotencyKey: randomUUID(), payload: {} },
      { actor: null },
    );

    const one = await jobQueue.processNext("loop", createRegistry([echo]));
    const two = await jobQueue.processNext("loop", createRegistry([flaky]));
    const three = await jobQueue.processNext("loop", createRegistry([throwing]));
    const idle = await jobQueue.processNext("loop", createRegistry([echo]));

    expect(one.ok && one.value.outcome).toBe("succeeded");
    expect(two.ok && two.value.outcome).toBe("retrying");
    expect(three.ok && three.value.outcome).toBe("failed");
    expect(idle.ok && idle.value.outcome).toBe("idle");

    if (three.ok && "jobId" in three.value) {
      expect(JSON.stringify(await row(three.value.jobId))).not.toContain("9876");
    }
  });

  it("keeps SQL backoff equal to the documented rule", async () => {
    const { retryDelaySeconds } = await modules();
    const rows = await sql!<{ attempts: number; seconds: number }[]>`
      select a as attempts,
             extract(epoch from make_interval(secs => least(30 * power(2, greatest(a, 1) - 1), 900)))::int as seconds
      from generate_series(1, 8) a`;
    expect(rows.map((entry) => entry.seconds)).toEqual(
      rows.map((entry) => retryDelaySeconds(entry.attempts)),
    );
  });
});

/* -------------------------------------------------------------------- cancel */

describe.skipIf(!local)("cancel: queued only, Super Admin only", () => {
  it("withdraws a queued job, refuses a running or finished one, and refuses a Worker", async () => {
    const { jobQueue, jobsService, createRegistry } = await modules();
    const type = await echoType();
    const registry = createRegistry([type]);

    const queued = await jobQueue.enqueue(
      type,
      { idempotencyKey: randomUUID(), payload: { n: 1 } },
      { actor: null },
    );
    const running = await jobQueue.enqueue(
      type,
      { idempotencyKey: randomUUID(), payload: { n: 2 } },
      { actor: null },
    );
    if (!queued.ok || !running.ok) throw new Error("enqueue");
    await sql!`update jobs set priority = 100 where id = ${running.value.job.id}::uuid`;
    const held = await jobQueue.claim("w", registry);
    expect(held.ok && held.value?.jobId).toBe(running.value.job.id);

    for (const actor of [worker, null]) {
      const refused = await jobsService.cancel(queued.value.job.id, { actor });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("FORBIDDEN");
    }
    expect((await row(queued.value.job.id)).status).toBe("queued");

    const cancelled = await jobsService.cancel(queued.value.job.id, { actor: admin });
    expect(cancelled.ok && cancelled.value.status).toBe("cancelled");

    const runningRefused = await jobsService.cancel(running.value.job.id, { actor: admin });
    expect(runningRefused.ok).toBe(false);
    if (!runningRefused.ok)
      expect(runningRefused.error.userMessage).toMatch(/running job cannot be cancelled/);
    expect((await row(running.value.job.id)).status).toBe("running");

    const again = await jobsService.cancel(queued.value.job.id, { actor: admin });
    expect(again.ok).toBe(false);

    /* A cancelled job is never claimed. */
    const next = await jobQueue.claim("w", registry);
    expect(next.ok && next.value).toBeNull();

    const trail = await audits(queued.value.job.id);
    expect(trail.map((entry) => [entry.event, entry.user_id])).toEqual([
      [null, null],
      ["job_cancelled", admin.id],
    ]);
  });
});

/* ------------------------------------------------- the database's own guards */

describe.skipIf(!local)("the table refuses invalid states, whoever writes", () => {
  it("rejects a running job without an owner, a finished one without a time, a cancelled one without cancelled_at", async () => {
    const { jobQueue } = await modules();
    const type = await echoType();
    const created = await jobQueue.enqueue(
      type,
      { idempotencyKey: randomUUID(), payload: { n: 1 } },
      { actor: null },
    );
    if (!created.ok) throw new Error("enqueue");
    const id = created.value.job.id;

    for (const statement of [
      sql!`update jobs set status = 'running' where id = ${id}::uuid`,
      sql!`update jobs set status = 'succeeded' where id = ${id}::uuid`,
      sql!`update jobs set status = 'cancelled', finished_at = now() where id = ${id}::uuid`,
      sql!`update jobs set claim_token = gen_random_uuid() where id = ${id}::uuid`,
      sql!`update jobs set attempts = 4 where id = ${id}::uuid`,
      sql!`update jobs set payload = '[]'::jsonb where id = ${id}::uuid`,
      sql!`insert into jobs (type, idempotency_key) values ('Bad Type', 'k')`,
    ]) {
      await expect(statement).rejects.toThrow(/violates check constraint/);
    }

    expect((await row(id)).status).toBe("queued");
  });

  it("refuses browser roles everything on jobs and receipts", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const statement of [
        "select * from jobs limit 1",
        "insert into jobs (type, idempotency_key) values ('x.y', 'k')",
        "update jobs set status = 'cancelled'",
        "delete from jobs",
        "select * from idempotency_keys limit 1",
        "insert into idempotency_keys (scope, key, request_hash) values ('x', 'k', repeat('a', 64))",
        "delete from idempotency_keys",
      ]) {
        await expect(
          sql!.begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            await tx.unsafe(statement);
          }),
          `${role}: ${statement}`,
        ).rejects.toThrow(/permission denied/);
      }
    }

    const [rls] = await sql!<{ jobs: boolean; keys: boolean }[]>`
      select (select relrowsecurity from pg_class where oid = 'public.jobs'::regclass) as jobs,
             (select relrowsecurity from pg_class where oid = 'public.idempotency_keys'::regclass) as keys`;
    expect(rls).toEqual({ jobs: true, keys: true });
    const policies =
      await sql!`select 1 from pg_policies where tablename in ('jobs', 'idempotency_keys')`;
    expect(policies).toHaveLength(0);
  });

  it("serves the claim from its index", async () => {
    const plan = await sql!.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      return tx.unsafe(`
        explain select id from jobs
        where status = 'queued' and available_at <= now() and attempts < max_attempts and type in ('a.b')
        order by priority desc nulls last, available_at, created_at, id
        limit 1 for update skip locked`);
    });
    expect(plan.map((line) => Object.values(line)[0]).join("\n")).toContain("jobs_claim_idx");
  });
});

/* ---------------------------------------------------------- stale recovery */

describe.skipIf(!local)("stale recovery: never re-runs work that committed", () => {
  async function staleJob(
    definitionType: Awaited<ReturnType<typeof echoType>>,
    attemptsLeft = true,
  ) {
    const { jobQueue, createRegistry } = await modules();
    const created = await jobQueue.enqueue(
      definitionType,
      { idempotencyKey: randomUUID(), payload: { n: 1 } },
      { actor: null },
    );
    if (!created.ok) throw new Error("enqueue");
    const claimed = await jobQueue.claim("doomed-worker", createRegistry([definitionType]));
    if (!claimed.ok || !claimed.value) throw new Error("no claim");
    await sql!`update jobs set heartbeat_at = now() - interval '10 minutes'
               ${attemptsLeft ? sql!`` : sql!`, max_attempts = attempts`}
               where id = ${claimed.value.jobId}::uuid`;
    return claimed.value;
  }

  it("requeues a job whose worker went silent, and the old owner can no longer finish it", async () => {
    const { jobQueue, createRegistry } = await modules();
    const type = await echoType();
    const registry = createRegistry([type]);
    const held = await staleJob(type);

    const fresh = await jobQueue.enqueue(
      type,
      { idempotencyKey: randomUUID(), payload: { n: 2 } },
      { actor: null },
    );
    const live = await jobQueue.claim("live-worker", registry);
    expect(live.ok && live.value?.jobId).toBe(fresh.ok && fresh.value.job.id);

    const report = await jobQueue.recoverStale(registry);
    expect(report.ok && report.value).toMatchObject({ requeued: 1, completed: 0, failed: 0 });

    expect(await row(held.jobId)).toMatchObject({
      status: "queued",
      claim_token: null,
      last_error_code: "JOB_STALE",
    });
    expect((await row(held.jobId)).recovered_at).not.toBeNull();
    /* The live job's fresh heartbeat kept it untouched. */
    expect((await row(live.ok ? live.value!.jobId : "")).status).toBe("running");

    /* The silent worker comes back: it no longer owns anything. */
    expect((await jobQueue.complete(held, { late: true })).ok).toBe(false);
    expect((await row(held.jobId)).status).toBe("queued");

    expect((await audits(held.jobId)).map((entry) => entry.event)).toContain("job_recovered");
  });

  it("fails a stale job with no attempts left", async () => {
    const { jobQueue, createRegistry } = await modules();
    const type = await echoType();
    const held = await staleJob(type, false);

    const report = await jobQueue.recoverStale(createRegistry([type]));
    expect(report.ok && report.value.failed).toBe(1);
    expect(await row(held.jobId)).toMatchObject({ status: "failed", last_error_code: "JOB_STALE" });
  });

  it("marks a stale job succeeded — not retried — when its receipt shows the work committed", async () => {
    const { jobQueue, createRegistry, defineJob, ok } = await modules();
    const scope = "test.receipt";
    const withReceipt = defineJob({
      type: `test.receipted_${randomUUID().slice(0, 8)}`,
      payload: z.object({ n: z.number() }),
      receipt: (job) => ({ scope, key: job.idempotencyKey }),
      async run() {
        return ok({});
      },
    });
    const held = await staleJob(withReceipt);

    /* The business transaction committed its receipt; then the worker died. */
    await sql!`insert into idempotency_keys (scope, key, request_hash, result)
               values (${scope}, ${held.idempotencyKey}, repeat('a', 64), '{}'::jsonb)`;

    const report = await jobQueue.recoverStale(createRegistry([withReceipt]));
    expect(report.ok && report.value).toMatchObject({ completed: 1, requeued: 0 });
    expect(await row(held.jobId)).toMatchObject({
      status: "succeeded",
      result: { recovered: true },
    });
  });

  it("leaves a stale job of a type it does not know untouched", async () => {
    const { jobQueue, createRegistry } = await modules();
    const known = await echoType();
    const unknown = await echoType();
    const held = await staleJob(unknown);

    const report = await jobQueue.recoverStale(createRegistry([known]));
    expect(report.ok && report.value.skipped).toBeGreaterThanOrEqual(1);
    expect((await row(held.jobId)).status).toBe("running");

    /* Cleaned up by a worker that knows it, so later tests see no stale rows of this type. */
    await jobQueue.recoverStale(createRegistry([unknown]));
  });

  it("review: fails — never requeues — a stale job that cannot prove its work completed", async () => {
    const { jobQueue, createRegistry, defineJob, ok } = await modules();

    /*
     * A type that declares neither a receipt nor retryOnStale is refused by
     * defineJob, so it can only reach recovery from JavaScript. Built here the
     * way such a caller would: around the type system, not through it.
     */
    const unverifiable = {
      ...defineJob({
        type: `test.unverifiable_${randomUUID().slice(0, 8)}`,
        payload: z.object({ n: z.number() }),
        retryOnStale: "re-running is safe" as const,
        async run() {
          return ok({});
        },
      }),
      retryOnStale: undefined,
    } as never;

    const held = await staleJob(unverifiable);
    const report = await jobQueue.recoverStale(createRegistry([unverifiable]));

    expect(report.ok && report.value).toMatchObject({ failed: 1, requeued: 0, completed: 0 });
    expect(await row(held.jobId)).toMatchObject({
      status: "failed",
      last_error_code: "JOB_UNVERIFIABLE",
    });
  });
});

/* ------------------------------------------------------------ the jobs page */

describe.skipIf(!local)("the jobs page service", () => {
  it("is Super Admin only, filters on the server, and never returns a payload or token", async () => {
    const { jobQueue, jobsService, parseJobsFilter } = await modules();
    const type = await echoType();
    const created = await jobQueue.enqueue(
      type,
      { idempotencyKey: `page-${randomUUID()}`, payload: { n: 42 } },
      { actor: admin },
    );
    if (!created.ok) throw new Error("enqueue");

    for (const actor of [worker, null]) {
      const refused = await jobsService.list(parseJobsFilter({}), actor);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("FORBIDDEN");
      expect((await jobsService.types(actor)).ok).toBe(false);
      expect((await jobsService.getDetail(created.value.job.id, actor)).ok).toBe(false);
    }

    const byType = await jobsService.list(parseJobsFilter({ type: type.type }), admin);
    expect(byType.ok && byType.value.total).toBe(1);
    expect(byType.ok && byType.value.items[0]?.id).toBe(created.value.job.id);

    const byId = await jobsService.list(parseJobsFilter({ search: created.value.job.id }), admin);
    expect(byId.ok && byId.value.items.map((item) => item.id)).toEqual([created.value.job.id]);

    const byStatus = await jobsService.list(
      parseJobsFilter({ type: type.type, status: "failed" }),
      admin,
    );
    expect(byStatus.ok && byStatus.value.total).toBe(0);

    const today = new Date().toISOString().slice(0, 10);
    const inRange = await jobsService.list(
      parseJobsFilter({ type: type.type, from: today, to: today }),
      admin,
    );
    expect(inRange.ok && inRange.value.total).toBe(1);
    const inverted = await jobsService.list(
      parseJobsFilter({ from: "2026-06-02", to: "2026-06-01" }),
      admin,
    );
    expect(inverted.ok).toBe(false);

    const wildcard = await jobsService.list(parseJobsFilter({ search: "%" }), admin);
    expect(wildcard.ok && wildcard.value.items.every((item) => item.type.includes("%"))).toBe(true);

    const serialized = JSON.stringify(byType.ok ? byType.value : null);
    expect(serialized).not.toContain('"payload"');
    expect(serialized).not.toContain("page-");
    expect(serialized).not.toContain('"claimToken"');

    const types = await jobsService.types(admin);
    expect(types.ok && types.value).toContain(type.type);
  });
});
