import type { AppError } from "@/lib/errors";

/**
 * The Result type.
 *
 * ADR-003 Rule 3: services return Result objects rather than throwing business
 * exceptions. A thrown exception is invisible to the type system; a Result is
 * part of the signature, so the compiler forces every caller to handle failure.
 *
 * 02_ARCHITECTURE.md defines types/ as global types only, which is why the type
 * lives here and its constructors live in utils/result.ts.
 */

export interface Success<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Failure<E extends AppError = AppError> {
  readonly ok: false;
  readonly error: E;
}

/**
 * Never return null or undefined for a business operation. Absence is modelled
 * explicitly — a record that does not exist is a Failure carrying NotFoundError,
 * not an exception and not a null.
 */
export type Result<T, E extends AppError = AppError> = Success<T> | Failure<E>;

/** A Result for an operation that succeeds with no meaningful value. */
export type VoidResult<E extends AppError = AppError> = Result<void, E>;
