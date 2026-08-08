import type { AppError } from "@/lib/errors";
import type { Failure, Result, Success } from "@/types/result";

/**
 * Result constructors and helpers.
 *
 * 02_ARCHITECTURE.md defines utils/ as pure helper functions with no business
 * logic and no API calls. These qualify.
 */

export function ok(): Success<void>;
export function ok<T>(value: T): Success<T>;
export function ok<T>(value?: T): Success<T | undefined> {
  return { ok: true, value };
}

export function fail<E extends AppError>(error: E): Failure<E> {
  return { ok: false, error };
}

export function isSuccess<T, E extends AppError>(result: Result<T, E>): result is Success<T> {
  return result.ok;
}

export function isFailure<T, E extends AppError>(result: Result<T, E>): result is Failure<E> {
  return !result.ok;
}

/**
 * Unwraps a Result, throwing the contained AppError on failure.
 *
 * ADR-003: this is the single sanctioned bridge between the Result world and
 * TanStack Query, whose failure channel is a rejected promise. Call it inside
 * `queryFn` and `mutationFn` only.
 *
 * Never call this inside a component. Components consume TanStack Query state.
 */
export function unwrap<T, E extends AppError>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }

  throw result.error;
}

/** Returns the value on success, or the supplied fallback on failure. */
export function unwrapOr<T, E extends AppError>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Transforms a successful value, leaving a failure untouched. */
export function mapResult<T, U, E extends AppError>(
  result: Result<T, E>,
  transform: (value: T) => U,
): Result<U, E> {
  return result.ok ? { ok: true, value: transform(result.value) } : result;
}
