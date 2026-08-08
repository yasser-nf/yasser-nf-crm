import "server-only";

import { PAGINATION } from "@/config/constants";
import { NotFoundError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";

/**
 * Shared repository primitives.
 *
 * Every repository needs the same two things: turn "no row" into a typed
 * failure, and clamp pagination input. Without a shared home, both get
 * reimplemented eight times and drift.
 *
 * This is infrastructure, not business logic. Nothing here knows what an account
 * or a profile is.
 */

export interface PaginationInput {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Clamps caller-supplied pagination into a safe range.
 *
 * 01_MASTER_RULES.md requires all lists to be paginated. Clamping here means an
 * unbounded query is impossible even if a caller passes `limit: 1000000` — the
 * ceiling is not advisory.
 */
export function normalizePagination(input: PaginationInput = {}): {
  limit: number;
  offset: number;
} {
  const requestedLimit = input.limit ?? PAGINATION.DEFAULT_PAGE_SIZE;
  const requestedOffset = input.offset ?? 0;

  return {
    limit: Math.min(Math.max(Math.trunc(requestedLimit), 1), PAGINATION.MAX_PAGE_SIZE),
    offset: Math.max(Math.trunc(requestedOffset), 0),
  };
}

/**
 * Converts an optional row into a Result.
 *
 * ADR-003: absence is not an exception and must never be returned as null. A
 * record that does not exist is a Failure carrying NotFoundError, so the
 * compiler forces the caller to handle it.
 *
 * `entityLabel` appears only in the technical message. The user-facing wording
 * comes from NotFoundError itself, so it cannot leak a table name.
 */
export function requireFound<T>(
  row: T | undefined,
  entityLabel: string,
  identifier: string,
): Result<T> {
  if (row === undefined) {
    return fail(
      new NotFoundError(`${entityLabel} not found`, {
        context: { entity: entityLabel, identifier },
      }),
    );
  }

  return ok(row);
}

/**
 * Reads the count from an aggregate query result.
 *
 * Drizzle returns `[{ count: n }]`, and an empty result set is possible on some
 * shapes. Defaulting to zero here keeps every repository's count method from
 * repeating the same guard.
 */
export function readCount(rows: readonly { count: number }[]): number {
  return rows[0]?.count ?? 0;
}
