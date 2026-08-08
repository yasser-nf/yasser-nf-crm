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

function isDriverError(value: unknown): value is DriverError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof (value as { code: unknown }).code === "string"
  );
}

function isRetryable(error: unknown): boolean {
  if (!isDriverError(error)) {
    return false;
  }

  return RETRYABLE_SQL_STATES.includes(error.code);
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
  if (!isDriverError(error)) {
    return toAppError(error);
  }

  const context = { operation, sqlState: error.code };

  switch (error.code) {
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
  logger.error("Database operation failed", error);

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
