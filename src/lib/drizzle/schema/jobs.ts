import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { jobStatusEnum } from "./enums";
import { users } from "./users";

/**
 * Durable jobs (M08 jobs). docs/JOBS_MODULE.md.
 *
 * The database is the queue. A row is created once per business operation
 * (`type` + `idempotency_key` is unique), claimed by exactly one worker at a
 * time (`claim_token`), kept alive by `heartbeat_at`, and finished exactly once.
 * Nothing about a job lives in process memory: a worker that dies leaves a
 * row whose heartbeat stops, and recovery finds it.
 *
 * The check constraints make the lifecycle's invariants hold for ANY writer —
 * a running job always has an owner, a waiting or finished one never does — so
 * a bug in a service cannot leave a row in a state the claim logic misreads.
 *
 * `payload` holds references (ids), never credentials: the registry refuses a
 * payload with a sensitive key before it is written, and a size check bounds it.
 * `result` is safe metadata for the same reason.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Registered job type, e.g. `netflix.verify_account` (M09). */
    type: text("type").notNull(),

    status: jobStatusEnum("status").notNull().default("queued"),

    /** Higher first. The service names three levels: urgent 10, normal 0, low -10. */
    priority: smallint("priority").notNull().default(0),

    /**
     * Derived from the business operation by the caller, never random per
     * request: enqueueing the same operation twice returns the first job.
     */
    idempotencyKey: text("idempotency_key").notNull(),

    /** References to existing records. Validated per type; never secrets. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),

    /** Safe outcome metadata, set on success. */
    result: jsonb("result").$type<Record<string, unknown>>(),

    /** Claims so far. Incremented at claim time, so a crash still counts. */
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),

    /** Not claimable before this instant: creation, or a retry's backoff. */
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),

    /** The current (or last) claim. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),

    /** Which worker holds it (an operational label, not a credential). */
    claimedBy: text("claimed_by"),

    /**
     * Proof of ownership. Issued at claim, required by every update a worker
     * makes, cleared when the claim ends. Worker A cannot finish worker B's job
     * because it does not hold B's token.
     */
    claimToken: uuid("claim_token"),

    /** Safe summary only — a user-facing message and an error code, never raw detail. */
    lastError: text("last_error"),
    lastErrorCode: text("last_error_code"),

    /** Set when stale recovery last took the job back from a silent worker. */
    recoveredAt: timestamp("recovered_at", { withTimezone: true }),

    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("jobs_type_idempotency_key_unique").on(table.type, table.idempotencyKey),

    /*
     * The claim: queued rows only, in exactly the order the claim reads them.
     * Partial, so it stays the size of the backlog however long history grows.
     */
    index("jobs_claim_idx")
      .on(table.priority.desc(), table.availableAt, table.createdAt, table.id)
      .where(sql`${table.status} = 'queued'`),

    /* Stale recovery: running rows by heartbeat. */
    index("jobs_running_heartbeat_idx")
      .on(table.heartbeatAt)
      .where(sql`${table.status} = 'running'`),

    /* The Super Admin list, newest first, optionally narrowed by status or type. */
    index("jobs_created_idx").on(table.createdAt.desc(), table.id.desc()),
    index("jobs_status_created_idx").on(table.status, table.createdAt.desc()),
    index("jobs_type_created_idx").on(table.type, table.createdAt.desc()),

    index("jobs_created_by_idx").on(table.createdBy),

    check("jobs_type_format", sql`${table.type} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$' and length(${table.type}) <= 64`),
    check(
      "jobs_idempotency_key_format",
      sql`length(${table.idempotencyKey}) between 1 and 200`,
    ),
    check("jobs_priority_range", sql`${table.priority} between -100 and 100`),
    check(
      "jobs_attempts_range",
      sql`${table.maxAttempts} between 1 and 20 and ${table.attempts} between 0 and ${table.maxAttempts}`,
    ),
    check("jobs_payload_object", sql`jsonb_typeof(${table.payload}) = 'object'`),
    check("jobs_payload_size", sql`pg_column_size(${table.payload}) <= 8192`),
    check(
      "jobs_result_size",
      sql`${table.result} is null or (jsonb_typeof(${table.result}) = 'object' and pg_column_size(${table.result}) <= 8192)`,
    ),
    check(
      "jobs_claimed_by_length",
      sql`${table.claimedBy} is null or length(${table.claimedBy}) between 1 and 100`,
    ),
    check(
      "jobs_last_error_length",
      sql`${table.lastError} is null or length(${table.lastError}) <= 500`,
    ),

    /* The lifecycle's invariants, true whoever writes the row. */
    check(
      "jobs_running_has_owner",
      sql`${table.status} <> 'running' or (${table.claimToken} is not null and ${table.claimedBy} is not null and ${table.startedAt} is not null and ${table.heartbeatAt} is not null)`,
    ),
    check(
      "jobs_only_running_is_owned",
      sql`${table.status} = 'running' or ${table.claimToken} is null`,
    ),
    check(
      "jobs_finished_iff_terminal",
      sql`(${table.status} in ('succeeded', 'failed', 'cancelled')) = (${table.finishedAt} is not null)`,
    ),
    check(
      "jobs_cancelled_iff_cancelled_at",
      sql`(${table.status} = 'cancelled') = (${table.cancelledAt} is not null)`,
    ),
  ],
);

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
