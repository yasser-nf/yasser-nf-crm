import { and, asc, count, eq, gte, ilike, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";

import {
  databaseAdapter,
  normalizePagination,
  type DatabaseTransaction,
  type Page,
} from "@/lib/database";
import { jobs, type JobRow, type NewJobRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import { RETRY_BASE_SECONDS, RETRY_MAX_SECONDS, type JobStatus } from "../services/job-states";

/**
 * The queue's SQL (M08 jobs). docs/JOBS_MODULE.md §4.
 *
 * Every state change is ONE statement whose WHERE names the state it moves
 * from — and, for anything a worker does, the claim token it must hold. So a
 * transition is atomic, an invalid one changes nothing (zero rows), and two
 * callers racing for the same transition cannot both win: the second's UPDATE
 * waits for the first's row lock, re-reads the row, and no longer matches.
 */

/** `ORDER BY` written to match the claim index exactly (DESC NULLS LAST, as created). */
const CLAIM_ORDER = [
  sql`${jobs.priority} desc nulls last`,
  asc(jobs.availableAt),
  asc(jobs.createdAt),
  asc(jobs.id),
];

/** Backoff in SQL — the same rule as `retryDelaySeconds` (a test keeps them equal). */
const retryDelaySql = sql`make_interval(secs => least(${RETRY_BASE_SECONDS} * power(2, greatest(${jobs.attempts}, 1) - 1), ${RETRY_MAX_SECONDS}))`;

export interface JobListFilter {
  readonly type?: string | undefined;
  readonly status?: JobStatus | undefined;
  /** Inclusive start / exclusive end of the creation time window. */
  readonly createdFrom?: Date | undefined;
  readonly createdBefore?: Date | undefined;
  /** A job id, or text inside the type or idempotency key — already LIKE-escaped. */
  readonly searchId?: string | undefined;
  readonly searchContains?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export type RecoveryOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "requeue"; readonly code: string; readonly message: string }
  | { readonly kind: "fail"; readonly code: string; readonly message: string };

export interface JobsRepository {
  /** Creates the job, or returns the one already created for this type + key. */
  insertOrGet(
    values: NewJobRow & { type: string; idempotencyKey: string },
  ): Promise<Result<{ readonly job: JobRow; readonly created: boolean }>>;

  /**
   * Claims the next available job of the given types for `workerId`, or null.
   *
   * One statement: the candidate is chosen with `FOR UPDATE SKIP LOCKED` — a
   * row another claim is locking is skipped, not waited on — and the UPDATE
   * re-checks `status = 'queued'` on the locked row. Two workers can never
   * hold the same job; each gets a different one or none.
   */
  claimNext(workerId: string, types: readonly string[]): Promise<Result<JobRow | null>>;

  /** Extends the claim. Null when this worker no longer owns the job. */
  heartbeat(id: string, claimToken: string): Promise<Result<JobRow | null>>;

  /** running → succeeded, for the owner only. */
  complete(
    id: string,
    claimToken: string,
    result: Record<string, unknown>,
  ): Promise<Result<JobRow | null>>;

  /**
   * running → queued (retryable and attempts remain, after backoff) or
   * running → failed. For the owner only. Decided in the statement, so the
   * attempt count it reads is the row's own.
   */
  retryOrFail(
    id: string,
    claimToken: string,
    failure: { readonly retryable: boolean; readonly code: string; readonly message: string },
  ): Promise<Result<JobRow | null>>;

  /** queued → cancelled. Null when the job is not queued (any more). */
  cancelQueued(id: string): Promise<Result<JobRow | null>>;

  findById(id: string): Promise<Result<JobRow | null>>;

  /** Running jobs whose heartbeat is older than `staleAfterSeconds`, locked for recovery. */
  lockStale(
    executor: DatabaseTransaction,
    staleAfterSeconds: number,
    limit: number,
  ): Promise<readonly JobRow[]>;

  /** Applies one recovery decision to a locked stale job. */
  applyRecovery(
    executor: DatabaseTransaction,
    id: string,
    outcome: RecoveryOutcome,
  ): Promise<JobRow | null>;

  list(filter: JobListFilter): Promise<Result<Page<JobRow>>>;

  /** The job types present, for the filter. */
  types(): Promise<Result<readonly string[]>>;
}

export const jobsRepository: JobsRepository = {
  async insertOrGet(values) {
    return databaseAdapter.query("jobs.insertOrGet", async (executor) => {
      const [inserted] = await executor
        .insert(jobs)
        .values(values)
        .onConflictDoNothing({ target: [jobs.type, jobs.idempotencyKey] })
        .returning();

      if (inserted) {
        return { job: inserted, created: true };
      }

      const [existing] = await executor
        .select()
        .from(jobs)
        .where(and(eq(jobs.type, values.type), eq(jobs.idempotencyKey, values.idempotencyKey)));

      if (!existing) {
        throw new Error("Job idempotency conflict could not be resolved");
      }

      return { job: existing, created: false };
    });
  },

  async claimNext(workerId, types) {
    return databaseAdapter.query("jobs.claimNext", async (executor) => {
      const candidate = executor
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.status, "queued"),
            lte(jobs.availableAt, sql`now()`),
            lt(jobs.attempts, jobs.maxAttempts),
            inArray(jobs.type, [...types]),
          ),
        )
        .orderBy(...CLAIM_ORDER)
        .limit(1)
        .for("update", { skipLocked: true });

      const [claimed] = await executor
        .update(jobs)
        .set({
          status: "running",
          claimToken: sql`gen_random_uuid()`,
          claimedBy: workerId,
          startedAt: sql`now()`,
          heartbeatAt: sql`now()`,
          attempts: sql`${jobs.attempts} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(jobs.id, sql`(${candidate})`), eq(jobs.status, "queued")))
        .returning();

      return claimed ?? null;
    });
  },

  async heartbeat(id, claimToken) {
    return databaseAdapter.query("jobs.heartbeat", async (executor) => {
      const [row] = await executor
        .update(jobs)
        .set({ heartbeatAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(jobs.id, id), eq(jobs.claimToken, claimToken), eq(jobs.status, "running")))
        .returning();

      return row ?? null;
    });
  },

  async complete(id, claimToken, result) {
    return databaseAdapter.query("jobs.complete", async (executor) => {
      const [row] = await executor
        .update(jobs)
        .set({
          status: "succeeded",
          result,
          finishedAt: sql`now()`,
          claimToken: null,
          lastError: null,
          lastErrorCode: null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(jobs.id, id), eq(jobs.claimToken, claimToken), eq(jobs.status, "running")))
        .returning();

      return row ?? null;
    });
  },

  async retryOrFail(id, claimToken, failure) {
    const retry = failure.retryable ? sql`${jobs.attempts} < ${jobs.maxAttempts}` : sql`false`;

    return databaseAdapter.query("jobs.retryOrFail", async (executor) => {
      const [row] = await executor
        .update(jobs)
        .set({
          status: sql`case when ${retry} then 'queued'::job_status else 'failed'::job_status end`,
          availableAt: sql`case when ${retry} then now() + ${retryDelaySql} else ${jobs.availableAt} end`,
          finishedAt: sql`case when ${retry} then null else now() end`,
          claimToken: null,
          lastError: failure.message.slice(0, 500),
          lastErrorCode: failure.code,
          updatedAt: sql`now()`,
        })
        .where(and(eq(jobs.id, id), eq(jobs.claimToken, claimToken), eq(jobs.status, "running")))
        .returning();

      return row ?? null;
    });
  },

  async cancelQueued(id) {
    return databaseAdapter.query("jobs.cancelQueued", async (executor) => {
      const [row] = await executor
        .update(jobs)
        .set({
          status: "cancelled",
          cancelledAt: sql`now()`,
          finishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(jobs.id, id), eq(jobs.status, "queued")))
        .returning();

      return row ?? null;
    });
  },

  async findById(id) {
    return databaseAdapter.query("jobs.findById", async (executor) => {
      const [row] = await executor.select().from(jobs).where(eq(jobs.id, id));
      return row ?? null;
    });
  },

  async lockStale(executor, staleAfterSeconds, limit) {
    return executor
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "running"),
          lt(jobs.heartbeatAt, sql`now() - make_interval(secs => ${staleAfterSeconds})`),
        ),
      )
      .orderBy(asc(jobs.heartbeatAt))
      .limit(limit)
      .for("update", { skipLocked: true });
  },

  async applyRecovery(executor, id, outcome) {
    const base = { claimToken: null, recoveredAt: sql`now()`, updatedAt: sql`now()` } as const;

    const set =
      outcome.kind === "completed"
        ? {
            ...base,
            status: "succeeded" as const,
            finishedAt: sql`now()`,
            result: { recovered: true },
            lastError: null,
            lastErrorCode: null,
          }
        : outcome.kind === "requeue"
          ? {
              ...base,
              status: "queued" as const,
              availableAt: sql`now() + ${retryDelaySql}`,
              lastError: outcome.message,
              lastErrorCode: outcome.code,
            }
          : {
              ...base,
              status: "failed" as const,
              finishedAt: sql`now()`,
              lastError: outcome.message,
              lastErrorCode: outcome.code,
            };

    const [row] = await executor
      .update(jobs)
      .set(set)
      .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
      .returning();

    return row ?? null;
  },

  async list(filter) {
    const { limit, offset } = normalizePagination(filter);
    const conditions: SQL[] = [];

    if (filter.type) conditions.push(eq(jobs.type, filter.type));
    if (filter.status) conditions.push(eq(jobs.status, filter.status));
    if (filter.createdFrom) conditions.push(gte(jobs.createdAt, filter.createdFrom));
    if (filter.createdBefore) conditions.push(lt(jobs.createdAt, filter.createdBefore));

    if (filter.searchId) {
      conditions.push(eq(jobs.id, filter.searchId));
    } else if (filter.searchContains) {
      const either = or(
        ilike(jobs.type, filter.searchContains),
        ilike(jobs.idempotencyKey, filter.searchContains),
      );
      if (either) conditions.push(either);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return databaseAdapter.query("jobs.list", async (executor) => {
      const [items, totals] = await Promise.all([
        executor
          .select()
          .from(jobs)
          .where(where)
          .orderBy(sql`${jobs.createdAt} desc nulls last`, sql`${jobs.id} desc nulls last`)
          .limit(limit)
          .offset(offset),
        executor.select({ total: count() }).from(jobs).where(where),
      ]);

      return { items, total: totals[0]?.total ?? 0, limit, offset };
    });
  },

  async types() {
    return databaseAdapter.query("jobs.types", async (executor) => {
      const rows = await executor
        .selectDistinct({ type: jobs.type })
        .from(jobs)
        .orderBy(asc(jobs.type))
        .limit(200);
      return rows.map((row) => row.type);
    });
  },
};
