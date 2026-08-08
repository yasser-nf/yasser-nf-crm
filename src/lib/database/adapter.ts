import "server-only";

import { drizzleClient, type DrizzleClient } from "@/lib/drizzle/client";
import { ConflictError, DatabaseError, toAppError, type AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";

/**
 * Database Adapter.
 *
 * ADR-003 Rule 1. The only module permitted to hold a database connection, and
 * the place raw PostgreSQL errors die.
 *
 * Repositories describe WHAT data is needed. The Adapter decides HOW it is
 * retrieved: connection, transaction scope, retry policy, error translation.
 * ADR-005 Decision 5 records why repositories may use Drizzle's query builder
 * while still being unable to reach a connection.
 *
 * No business logic lives here. The Adapter never knows what a profile is.
 */

type TransactionCallback = Parameters<DrizzleClient["transaction"]>[0];

/** The transaction-scoped client handed to work inside `transaction`. */
export type DatabaseTransaction = Parameters<TransactionCallback>[0];

/** Either the pooled client or a transaction. Repositories accept this. */
export type DatabaseExecutor = DrizzleClient | DatabaseTransaction;

/** PostgreSQL SQLSTATE codes worth distinguishing. */
const SQL_STATE = {
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  NOT_NULL_VIOLATION: "23502",
  CHECK_VIOLATION: "23514",
  SERIALIZATION_FAILURE: "40001",
  DEADLOCK_DETECTED: "40P01",
  /** Class 08 — connection exceptions. */
  CONNECTION_EXCEPTION: "08000",
  CONNECTION_DOES_NOT_EXIST: "08003",
  CONNECTION_FAILURE: "08006",
  CANNOT_CONNECT_NOW: "57P03",
  ADMIN_SHUTDOWN: "57P01",
} as const;

/**
 * Failures that a later attempt can plausibly succeed at.
 *
 * Deliberately narrow. Retrying a constraint violation cannot help — the data is
 * wrong, and retrying only delays the error while holding a connection. These
 * are the transient cases: the pooler dropped us, the database is failing over,
 * or two transactions collided.
 */
const RETRYABLE_SQL_STATES: readonly string[] = [
  SQL_STATE.SERIALIZATION_FAILURE,
  SQL_STATE.DEADLOCK_DETECTED,
  SQL_STATE.CONNECTION_EXCEPTION,
  SQL_STATE.CONNECTION_DOES_NOT_EXIST,
  SQL_STATE.CONNECTION_FAILURE,
  SQL_STATE.CANNOT_CONNECT_NOW,
  SQL_STATE.ADMIN_SHUTDOWN,
];

const RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 500,
} as const;

interface DriverError {
  readonly code: string;
  readonly message: string;
}

/** SQLSTATE is always five characters of [0-9A-Z], e.g. 23505, 40P01. */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * Network-level failures worth retrying.
 *
 * These arrive from Node rather than PostgreSQL, so they carry no SQLSTATE. A
 * dropped connection to the pooler is exactly as transient as a serialization
 * failure and deserves the same treatment.
 */
const RETRYABLE_NETWORK_CODES: readonly string[] = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
];

const MAX_CAUSE_DEPTH = 6;

/**
 * Finds the real driver error inside whatever wrapper reached us.
 *
 * Drizzle does not rethrow the driver's error — it wraps it in a
 * DrizzleQueryError carrying the SQL and parameters, and hangs the original off
 * `cause`. Inspecting only the top-level object therefore never finds a
 * SQLSTATE, which silently turned every constraint violation into a generic
 * failure and disabled the retry policy at the same time. Found by the M04.5
 * runtime harness; a unique-violation surfaced as UNEXPECTED_ERROR rather than
 * ConflictError, so the customers race handler never recognised it.
 *
 * The cause chain is walked rather than assumed one level deep, because a
 * transaction wraps errors again on the way out.
 */
function findDriverError(value: unknown, depth = 0): DriverError | null {
  if (depth > MAX_CAUSE_DEPTH || typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as { code?: unknown; message?: unknown; cause?: unknown };

  if (typeof candidate.code === "string" && candidate.code.length > 0) {
    return {
      code: candidate.code,
      message: typeof candidate.message === "string" ? candidate.message : String(value),
    };
  }

  return findDriverError(candidate.cause, depth + 1);
}

function isSqlState(code: string): boolean {
  return SQLSTATE_PATTERN.test(code);
}

function isRetryable(error: unknown): boolean {
  const driverError = findDriverError(error);

  if (!driverError) {
    return false;
  }

  return (
    RETRYABLE_SQL_STATES.includes(driverError.code) ||
    RETRYABLE_NETWORK_CODES.includes(driverError.code)
  );
}

/**
 * Exponential backoff with jitter.
 *
 * Jitter matters under contention: without it, several requests that collided
 * once retry in lockstep and collide again at the same moment.
 */
function backoffDelayMs(attempt: number): number {
  const exponential = RETRY_POLICY.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, RETRY_POLICY.maxDelayMs);

  return capped / 2 + Math.random() * (capped / 2);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Converts a driver failure into an AppError.
 *
 * The original message is preserved in `cause` for logs and never reaches the
 * user — a constraint name tells them nothing and leaks schema shape.
 */
function translateDriverError(error: unknown, operation: string): AppError {
  const driverError = findDriverError(error);

  if (!driverError || !isSqlState(driverError.code)) {
    return toAppError(error);
  }

  const context = { operation, sqlState: driverError.code };

  switch (driverError.code) {
    case SQL_STATE.UNIQUE_VIOLATION:
      return new ConflictError(`Unique constraint violated during ${operation}`, {
        cause: error,
        context,
        userMessage: "That already exists.",
      });

    case SQL_STATE.FOREIGN_KEY_VIOLATION:
      return new ConflictError(`Foreign key constraint violated during ${operation}`, {
        cause: error,
        context,
        userMessage: "This is still linked to other records and cannot be changed.",
      });

    case SQL_STATE.NOT_NULL_VIOLATION:
    case SQL_STATE.CHECK_VIOLATION:
      return new DatabaseError(`Constraint violated during ${operation}`, {
        cause: error,
        context,
      });

    default:
      return new DatabaseError(`Database operation failed: ${operation}`, {
        cause: error,
        context,
      });
  }
}

/**
 * Runs work with the retry policy applied, returning a Result.
 *
 * `operation` is a short description used in logs, so a failure is traceable
 * without attaching a stack trace to user-visible output.
 */
async function runWithRetry<T>(operation: string, run: () => Promise<T>): Promise<Result<T>> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= RETRY_POLICY.maxAttempts; attempt += 1) {
    try {
      return ok(await run());
    } catch (caught) {
      lastError = caught;

      const canRetry = isRetryable(caught) && attempt < RETRY_POLICY.maxAttempts;

      if (!canRetry) {
        break;
      }

      const delay = backoffDelayMs(attempt);

      logger.warn("Retrying database operation after a transient failure", {
        operation,
        attempt,
        maxAttempts: RETRY_POLICY.maxAttempts,
        delayMs: Math.round(delay),
      });

      await sleep(delay);
    }
  }

  const error = translateDriverError(lastError, operation);

  /*
   * Operational failures are expected conditions the system knows how to
   * handle — a unique violation losing a find-or-create race, for instance. The
   * caller recovers, so logging them at error level fills the log with alerts
   * for things that worked. Genuine defects still log as errors.
   */
  if (error.isOperational) {
    logger.warn("Database operation rejected", { operation, code: error.code });
  } else {
    logger.error("Database operation failed", error);
  }

  return fail(error);
}

/** Runs a database operation on the pooled connection. */
async function query<T>(
  operation: string,
  run: (executor: DatabaseExecutor) => Promise<T>,
): Promise<Result<T>> {
  return runWithRetry(operation, () => run(drizzleClient));
}

/**
 * Runs several operations atomically.
 *
 * Throwing inside the callback rolls the transaction back — that is the driver's
 * contract and cannot be expressed with Result, so the callback works in
 * exceptions and this function restores the Result boundary on the way out.
 *
 * Retries apply to the transaction as a whole. That is what makes retrying a
 * serialization failure or deadlock safe: the failed attempt left nothing behind.
 */
async function transaction<T>(
  operation: string,
  run: (executor: DatabaseTransaction) => Promise<T>,
): Promise<Result<T>> {
  return runWithRetry(operation, () => drizzleClient.transaction((tx) => run(tx)));
}

export const databaseAdapter = { query, transaction } as const;
