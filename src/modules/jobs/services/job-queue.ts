import "server-only";

import { databaseAdapter } from "@/lib/database";
import type { JobRow } from "@/lib/drizzle/schema";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  toAppError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { roleHasPermission, type Permission } from "@/config/roles";
import { auditService, type AuditContext } from "@/modules/audit";
import { idempotency, requestHash } from "@/modules/idempotency";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { jobsRepository, type RecoveryOutcome } from "../repositories/jobs.repository";
import {
  assertSafePayload,
  type AnyJobDefinition,
  type JobDefinition,
  type JobRegistry,
} from "./job-definition";
import { JobRetryableError, STALE_ERROR_CODE, classifyFailure } from "./job-errors";
import {
  HEARTBEAT_EVERY_MS,
  JOB_PRIORITIES,
  STALE_AFTER_MS,
  type JobPriorityName,
} from "./job-states";

/**
 * The worker contract (M08 jobs). docs/JOBS_MODULE.md §4–§8.
 *
 * Server-side only, and the ONLY way a job's state changes. No Server Action
 * or route exposes enqueue, claim, heartbeat, complete or fail: a browser can
 * reach none of them, and the jobs table refuses browser roles outright (RLS).
 * M09's worker is a server process that imports this module.
 *
 *   enqueue      create a job, once per business operation (type + key)
 *   claim        take the next available job; returns a claim token
 *   heartbeat    keep the claim alive while working
 *   complete     finish with safe result metadata
 *   fail         finish or retry, depending on the failure's classification
 *   retry        ask for a retry explicitly
 *   recoverStale take back jobs whose worker went silent — after checking
 *                whether their business operation already committed
 *   processNext  the reference loop body: claim, run, heartbeat, finish
 *
 * Every worker call presents the claim token. Worker A cannot heartbeat,
 * complete or fail worker B's job: the statement matches no row.
 */

/** What a worker holds after a successful claim. */
export interface Claim {
  readonly jobId: string;
  readonly type: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly claimToken: string;
  readonly workerId: string;
}

export interface EnqueueInput<P> {
  /** Derived from the business operation — the same operation, the same key. */
  readonly idempotencyKey: string;
  readonly payload: P;
  readonly priority?: JobPriorityName | undefined;
  /** Not claimable before this instant. Defaults to now. */
  readonly availableAt?: Date | undefined;
}

/** A job type may require a permission of whoever enqueues it. Optional. */
export interface EnqueueOptions {
  readonly permission?: Permission | undefined;
}

const WORKER_ID = /^[A-Za-z0-9._:@-]{1,100}$/;

function lostClaim(jobId: string): ConflictError {
  return new ConflictError("Job claim no longer held", {
    userMessage: "This worker no longer owns the job.",
    context: { jobId, lostClaim: true },
  });
}

function auditJob(job: JobRow, event: string | null, context: AuditContext): Promise<void> {
  return auditService.recordOrWarn(
    {
      entity: "job",
      entityId: job.id,
      action: event === null ? "create" : "update",
      after: {
        ...(event ? { event } : {}),
        id: job.id,
        type: job.type,
        status: job.status,
        priority: job.priority,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        availableAt: job.availableAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        cancelledAt: job.cancelledAt,
        claimedBy: job.claimedBy,
        lastError: job.lastError,
        lastErrorCode: job.lastErrorCode,
        recoveredAt: job.recoveredAt,
        createdBy: job.createdBy,
        createdAt: job.createdAt,
      },
    },
    context,
  );
}

function workerContext(workerId: string): AuditContext {
  return { actor: null, userAgent: `job-worker:${workerId}` };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Creates the job for one business operation, or returns the job already
 * created for it. Repeating an enqueue — a retried request, a double click on
 * whatever triggered it — never creates a second job; repeating it with a
 * DIFFERENT payload under the same key is refused, not silently merged.
 */
async function enqueue<P>(
  definition: JobDefinition<P>,
  input: EnqueueInput<P>,
  context: AuditContext,
  options: EnqueueOptions = {},
): Promise<Result<{ readonly job: JobRow; readonly created: boolean }>> {
  if (
    options.permission !== undefined &&
    context.actor !== null &&
    !roleHasPermission(context.actor.role, options.permission)
  ) {
    return fail(
      new ForbiddenError(`Actor may not enqueue ${definition.type}`, {
        userMessage: "You do not have permission to start this.",
      }),
    );
  }

  const key = input.idempotencyKey.trim();

  if (key.length === 0 || key.length > 200) {
    return fail(new ValidationError("Job idempotency key must be 1–200 characters"));
  }

  const parsed = definition.payload.safeParse(input.payload);

  if (!parsed.success || !isPlainObject(parsed.data)) {
    return fail(
      new ValidationError(`Invalid payload for job type ${definition.type}`, {
        userMessage: "The job could not be created: its details are invalid.",
      }),
    );
  }

  const payload = parsed.data;

  try {
    assertSafePayload(payload);
  } catch (caught) {
    return fail(toAppError(caught));
  }

  const written = await jobsRepository.insertOrGet({
    type: definition.type,
    idempotencyKey: key,
    payload,
    priority: JOB_PRIORITIES[input.priority ?? definition.priority ?? "normal"],
    maxAttempts: definition.maxAttempts ?? 3,
    ...(input.availableAt ? { availableAt: input.availableAt } : {}),
    createdBy: context.actor?.id ?? null,
  });

  if (!written.ok) {
    return written;
  }

  if (!written.value.created) {
    if (requestHash(written.value.job.payload) !== requestHash(payload)) {
      return fail(
        new ConflictError("Job idempotency key reused with a different payload", {
          userMessage: "A different job already exists for this operation.",
          context: { jobId: written.value.job.id },
        }),
      );
    }

    return written;
  }

  await auditJob(written.value.job, null, context);

  return written;
}

/** Claims the next available job of a type this worker can run, or null. */
async function claim(workerId: string, registry: JobRegistry): Promise<Result<Claim | null>> {
  if (!WORKER_ID.test(workerId)) {
    return fail(new ValidationError("Invalid worker id"));
  }

  const types = [...registry.keys()];

  if (types.length === 0) {
    return ok(null);
  }

  const claimed = await jobsRepository.claimNext(workerId, types);

  if (!claimed.ok || claimed.value === null) {
    return claimed.ok ? ok(null) : claimed;
  }

  const job = claimed.value;

  /* The CHECK constraint guarantees a running row has a token; asserted, not assumed. */
  if (!job.claimToken) {
    return fail(new ConflictError("Claimed job carries no claim token"));
  }

  return ok({
    jobId: job.id,
    type: job.type,
    idempotencyKey: job.idempotencyKey,
    payload: job.payload,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    claimToken: job.claimToken,
    workerId,
  });
}

/** Keeps the claim alive. A refusal means the claim is gone: stop working. */
async function heartbeat(held: Claim): Promise<Result<true>> {
  const row = await jobsRepository.heartbeat(held.jobId, held.claimToken);

  if (!row.ok) {
    return row;
  }

  return row.value ? ok(true) : fail(lostClaim(held.jobId));
}

/** Finishes the job successfully. `result` is safe metadata: references and counts. */
async function complete(
  held: Claim,
  result: Record<string, unknown> = {},
): Promise<Result<JobRow>> {
  try {
    assertSafePayload(result);
  } catch (caught) {
    return fail(toAppError(caught));
  }

  const row = await jobsRepository.complete(held.jobId, held.claimToken, result);

  if (!row.ok) {
    return row;
  }

  if (!row.value) {
    /*
     * Zero rows. If the job is already succeeded — this very completion
     * retried after its acknowledgement was lost, or recovery having proved the
     * work done — there is nothing to change and nothing to report. Anything
     * else means the claim was lost.
     */
    const current = await jobsRepository.findById(held.jobId);

    if (current.ok && current.value?.status === "succeeded") {
      return ok(current.value);
    }

    return fail(lostClaim(held.jobId));
  }

  await auditJob(row.value, "job_succeeded", workerContext(held.workerId));

  return ok(row.value);
}

/**
 * Records a failure. Retryable with attempts left → queued again after a
 * backoff; otherwise → failed. Only a safe summary is stored; the technical
 * detail goes to the server log through the M06 safe path.
 */
async function failJob(held: Claim, error: unknown): Promise<Result<JobRow>> {
  const summary = classifyFailure(error);

  const where = { jobId: held.jobId, type: held.type, attempt: held.attempt };

  /*
   * A defect is logged as one, through the M06 safe path (toLogObject scrubs
   * bound values). An expected failure is a warning with its code only.
   */
  if (summary.code === "UNEXPECTED_ERROR") {
    logger.error("Job failed unexpectedly", toAppError(error), where);
  } else {
    logger.warn("Job attempt failed", {
      ...where,
      code: summary.code,
      retryable: summary.retryable,
    });
  }

  const row = await jobsRepository.retryOrFail(held.jobId, held.claimToken, summary);

  if (!row.ok) {
    return row;
  }

  if (!row.value) {
    return fail(lostClaim(held.jobId));
  }

  if (row.value.status === "failed") {
    await auditJob(row.value, "job_failed", workerContext(held.workerId));
  }

  return ok(row.value);
}

/** Asks for a retry explicitly (counts as an attempt; fails once they run out). */
async function retry(
  held: Claim,
  reason = "The worker asked for a retry.",
): Promise<Result<JobRow>> {
  return failJob(held, new JobRetryableError(reason, { userMessage: reason.slice(0, 500) }));
}

export interface RecoveryReport {
  /** The business operation had committed: marked succeeded, never re-run. */
  readonly completed: number;
  readonly requeued: number;
  readonly failed: number;
  /** Stale jobs of types this registry does not know — left for a worker that does. */
  readonly skipped: number;
}

/**
 * Takes back jobs whose worker stopped heartbeating (M08 jobs §7).
 *
 * For each stale job, BEFORE anything is retried: if its type declares a
 * receipt and that receipt has committed, the business operation already
 * happened — the worker died after its transaction but before reporting — and
 * the job is marked succeeded, not run again. Otherwise it is queued again
 * (attempts remain) or failed (they do not). A type this registry does not
 * know is left untouched: recovery cannot judge work it does not understand.
 *
 * One transaction, the stale rows locked with SKIP LOCKED, so two recoveries
 * at once divide the work instead of doubling it.
 */
async function recoverStale(
  registry: JobRegistry,
  options: { readonly staleAfterMs?: number; readonly limit?: number } = {},
): Promise<Result<RecoveryReport>> {
  const staleAfterSeconds = Math.max(
    1,
    Math.round((options.staleAfterMs ?? STALE_AFTER_MS) / 1000),
  );
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);

  const outcome = await databaseAdapter.transaction("jobs.recoverStale", async (executor) => {
    const stale = await jobsRepository.lockStale(executor, staleAfterSeconds, limit);
    const changed: JobRow[] = [];
    let skipped = 0;

    for (const job of stale) {
      const definition: AnyJobDefinition | undefined = registry.get(job.type);

      if (!definition) {
        skipped += 1;
        continue;
      }

      let decision: RecoveryOutcome;
      const payload = definition.payload.safeParse(job.payload);

      if (!payload.success) {
        decision = {
          kind: "fail",
          code: "VALIDATION_ERROR",
          message: "The job's details are invalid, so it cannot be retried.",
        };
      } else {
        const receipt = definition.receipt?.({
          idempotencyKey: job.idempotencyKey,
          payload: payload.data,
        });
        const done = receipt ? await idempotency.committed(executor, receipt) : false;

        decision = done
          ? { kind: "completed" }
          : job.attempts >= job.maxAttempts
            ? {
                kind: "fail",
                code: STALE_ERROR_CODE,
                message: "The worker stopped responding and no attempts remain.",
              }
            : {
                kind: "requeue",
                code: STALE_ERROR_CODE,
                message: "The worker stopped responding; the job was returned to the queue.",
              };
      }

      const row = await jobsRepository.applyRecovery(executor, job.id, decision);

      if (row) {
        changed.push(row);
      }
    }

    return { changed, skipped };
  });

  if (!outcome.ok) {
    return outcome;
  }

  const context: AuditContext = { actor: null, userAgent: "job-recovery" };

  for (const row of outcome.value.changed) {
    await auditJob(row, "job_recovered", context);
  }

  const count = (status: JobRow["status"]) =>
    outcome.value.changed.filter((row) => row.status === status).length;

  return ok({
    completed: count("succeeded"),
    requeued: count("queued"),
    failed: count("failed"),
    skipped: outcome.value.skipped,
  });
}

export type ProcessOutcome =
  | { readonly outcome: "idle" }
  | { readonly outcome: "succeeded" | "retrying" | "failed"; readonly jobId: string }
  | { readonly outcome: "lost_claim"; readonly jobId: string };

/**
 * The reference worker loop body: claim one job, run it with heartbeats, and
 * finish it. A long-running worker (M09) calls `recoverStale` now and then and
 * this in a loop. In-process timers here only keep THIS claim alive while its
 * handler runs; nothing is scheduled for later — the queue is the database.
 */
async function processNext(
  workerId: string,
  registry: JobRegistry,
  options: { readonly heartbeatEveryMs?: number } = {},
): Promise<Result<ProcessOutcome>> {
  const claimed = await claim(workerId, registry);

  if (!claimed.ok) {
    return claimed;
  }

  if (!claimed.value) {
    return ok({ outcome: "idle" });
  }

  const held = claimed.value;
  const definition = registry.get(held.type);

  if (!definition) {
    /* Cannot happen — the claim is restricted to this registry's types. */
    return fail(new NotFoundError(`No definition for job type ${held.type}`));
  }

  const payload = definition.payload.safeParse(held.payload);

  if (!payload.success) {
    const failed = await failJob(
      held,
      new ValidationError("Stored job payload no longer matches its type", {
        userMessage: "The job's details are invalid, so it cannot run.",
      }),
    );
    return failed.ok ? ok({ outcome: "failed", jobId: held.jobId }) : failed;
  }

  const controller = new AbortController();
  const timer = setInterval(() => {
    void heartbeat(held).then((beat) => {
      if (!beat.ok) controller.abort();
    });
  }, options.heartbeatEveryMs ?? HEARTBEAT_EVERY_MS);

  let result: Result<Record<string, unknown>> | { readonly ok: false; readonly thrown: unknown };

  try {
    result = await definition.run({
      jobId: held.jobId,
      type: held.type,
      idempotencyKey: held.idempotencyKey,
      attempt: held.attempt,
      payload: payload.data,
      signal: controller.signal,
    });
  } catch (caught) {
    result = { ok: false, thrown: caught };
  } finally {
    clearInterval(timer);
  }

  /* The claim was lost mid-run: whatever happened is recovery's to judge, not ours. */
  if (controller.signal.aborted) {
    return ok({ outcome: "lost_claim", jobId: held.jobId });
  }

  if (result.ok) {
    const done = await complete(held, result.value);
    return done.ok
      ? ok({ outcome: "succeeded", jobId: held.jobId })
      : isLost(done.error)
        ? ok({ outcome: "lost_claim", jobId: held.jobId })
        : done;
  }

  const failure = "thrown" in result ? result.thrown : result.error;
  const finished = await failJob(held, failure);

  if (!finished.ok) {
    return isLost(finished.error) ? ok({ outcome: "lost_claim", jobId: held.jobId }) : finished;
  }

  return ok({
    outcome: finished.value.status === "queued" ? "retrying" : "failed",
    jobId: held.jobId,
  });
}

function isLost(error: unknown): boolean {
  return error instanceof ConflictError && error.context?.["lostClaim"] === true;
}

export const jobQueue = {
  enqueue,
  claim,
  heartbeat,
  complete,
  fail: failJob,
  retry,
  recoverStale,
  processNext,
} as const;
