import { AppError, isAppError } from "@/lib/errors";

/**
 * How a job failure is classified and what of it is kept (M08 jobs).
 *
 * Retryable: the failure says nothing about the work — the database or a
 * network was briefly unavailable, a worker timed out. Another attempt can
 * plausibly succeed.
 *
 * Permanent: the failure IS the answer — the account is unavailable, the
 * profile already sold, the payload invalid, the caller not permitted.
 * Retrying would only repeat it, or worse, keep trying something that should
 * not happen.
 *
 * What is stored is a SAFE summary: an error code and the user-facing message
 * every AppError already carries (written to be shown, never containing a
 * bound value or a secret). The technical detail goes to the server log
 * through the M06 safe path (`logger.error` → describeCause), never into the
 * jobs table — so no second sanitiser exists to drift from the first.
 */

/** Thrown or returned by a job handler to ask for a retry explicitly. */
export class JobRetryableError extends AppError {
  readonly code = "JOB_RETRYABLE";
  readonly severity = "medium" as const;
  protected readonly defaultUserMessage = "The job hit a temporary problem and will be retried.";
}

/** Recorded when a worker stops heartbeating. */
export const STALE_ERROR_CODE = "JOB_STALE";

/**
 * Recorded when a stale job cannot prove whether its work committed, so it is
 * failed rather than retried. `defineJob` makes such a type unrepresentable;
 * this is what recovery records if one reaches it from JavaScript.
 */
export const UNVERIFIABLE_ERROR_CODE = "JOB_UNVERIFIABLE";

/** PostgreSQL classes that describe the connection or a collision, not the data. */
const TRANSIENT_SQL_STATE = /^(08|40001|40P01|57P0[1-3]|53)/;

/** Node network errors that carry no SQLSTATE. */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
]);

/** Errors that are the answer, not an accident. */
const PERMANENT_CODES = new Set([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CONFIGURATION_ERROR",
]);

export interface FailureSummary {
  readonly retryable: boolean;
  readonly code: string;
  /** Safe to store and to show. */
  readonly message: string;
}

const UNEXPECTED_MESSAGE = "The job failed unexpectedly. The details are in the server log.";

function sqlStateOf(error: AppError): string | undefined {
  const state = error.context?.["sqlState"];
  return typeof state === "string" ? state : undefined;
}

export function classifyFailure(error: unknown): FailureSummary {
  if (error instanceof JobRetryableError) {
    return { retryable: true, code: error.code, message: error.userMessage };
  }

  if (isAppError(error)) {
    const sqlState = sqlStateOf(error);

    const retryable =
      error.code === "EXTERNAL_SERVICE_ERROR" ||
      (error.code === "DATABASE_ERROR" &&
        (sqlState === undefined || TRANSIENT_SQL_STATE.test(sqlState)));

    return {
      retryable: retryable && !PERMANENT_CODES.has(error.code),
      code: error.code,
      message: error.userMessage.slice(0, 500),
    };
  }

  const code =
    error !== null &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;

  if (code && TRANSIENT_NETWORK_CODES.has(code)) {
    return {
      retryable: true,
      code: "NETWORK_ERROR",
      message: "A network connection failed. The job will be retried.",
    };
  }

  /*
   * Anything else is a defect in the handler. Not retried: running broken code
   * again does not fix it, and a handler that throws unexpectedly halfway is
   * the case where repeating it is least safe.
   */
  return { retryable: false, code: "UNEXPECTED_ERROR", message: UNEXPECTED_MESSAGE };
}
