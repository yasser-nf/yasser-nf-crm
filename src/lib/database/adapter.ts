import "server-only";

import { drizzleClient, type DrizzleClient } from "@/lib/drizzle/client";
import { ConflictError, DatabaseError, toAppError, type AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";

/**
 * Database Adapter.
 *
 * ADR-003 Rule 1. This is the only module in the application permitted to
 * import Drizzle, and it is where raw PostgreSQL errors die.
 *
 * Repositories describe WHAT data is needed. The Adapter decides HOW it is
 * retrieved. That split is what makes 01_MASTER_RULES.md's "never expose
 * technical errors to users" a structural guarantee rather than a habit — there
 * is exactly one place where a driver error can enter the system, and it cannot
 * leave without becoming an AppError.
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

/**
 * Converts a driver failure into an AppError.
 *
 * The original message is preserved for logs via `cause` but never reaches the
 * user — a constraint name would tell them nothing and would leak schema shape.
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
 * Runs a database operation and returns a Result.
 *
 * `operation` is a short description used in logs. It exists so a failure is
 * traceable without attaching a stack trace to user-visible output.
 */
async function query<T>(
  operation: string,
  run: (executor: DatabaseExecutor) => Promise<T>,
): Promise<Result<T>> {
  try {
    return ok(await run(drizzleClient));
  } catch (caught) {
    const error = translateDriverError(caught, operation);
    logger.error("Database operation failed", error);
    return fail(error);
  }
}

/**
 * Runs several operations atomically.
 *
 * Throwing inside the callback rolls the transaction back — that is the driver's
 * contract and cannot be expressed with Result, so the callback works in
 * exceptions and this function converts the outcome back into a Result at the
 * boundary.
 */
async function transaction<T>(
  operation: string,
  run: (executor: DatabaseTransaction) => Promise<T>,
): Promise<Result<T>> {
  try {
    return ok(await drizzleClient.transaction((tx) => run(tx)));
  } catch (caught) {
    const error = translateDriverError(caught, operation);
    logger.error("Database transaction failed", error);
    return fail(error);
  }
}

export const databaseAdapter = { query, transaction } as const;
