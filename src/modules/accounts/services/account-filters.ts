import { PAGINATION } from "@/config/constants";
import type { AccountRow } from "@/lib/drizzle/schema";
import type { AccountFilter, AccountSortField } from "../repositories/accounts.repository";

/**
 * Turning a query string into an account filter.
 *
 * Lifted out of the accounts page so the CSV export can run the identical
 * parse. "Export filtered accounts" has to mean the filter the operator is
 * looking at, and the only way to guarantee that is for one function to decide
 * what the query string means.
 *
 * It is also the validation boundary. Query strings are user input, and the
 * export receives them from a browser rather than from Next's router, so every
 * value is matched against a known set here. An unrecognised sort column or
 * status falls back to the default rather than reaching the repository.
 */

export const ACCOUNT_SORT_FIELDS: readonly AccountSortField[] = [
  "email",
  "status",
  "healthScore",
  "country",
  "createdAt",
];

export const ACCOUNT_STATUSES: readonly AccountRow["status"][] = [
  "healthy",
  "payment_problem",
  "incorrect_password",
  "invalid_email",
  "something_went_wrong",
  "archived",
  "deleted",
];

export type RawSearchParams = Record<string, string | string[] | undefined>;

export function readParam(params: RawSearchParams, key: string): string | undefined {
  const value = params[key];

  return Array.isArray(value) ? value[0] : value;
}

/**
 * The filter as the page needs it.
 *
 * `AccountFilter` leaves sort and pagination optional because a repository
 * caller may omit them. The parser always decides them, and the table renders
 * the current sort, so narrowing here keeps that prop non-optional rather than
 * making every consumer re-assert a default the parser already applied.
 */
export interface ParsedAccountFilter extends AccountFilter {
  readonly sortBy: AccountSortField;
  readonly sortDirection: "asc" | "desc";
  readonly offset: number;
  readonly limit: number;
}

export function parseAccountFilter(params: RawSearchParams): ParsedAccountFilter {
  const offsetRaw = Number.parseInt(readParam(params, "offset") ?? "0", 10);
  const sortByRaw = readParam(params, "sortBy");
  const statusRaw = readParam(params, "status");

  return {
    search: readParam(params, "search"),
    status: ACCOUNT_STATUSES.find((value) => value === statusRaw),
    sortBy: ACCOUNT_SORT_FIELDS.find((field) => field === sortByRaw) ?? "createdAt",
    sortDirection: readParam(params, "sortDirection") === "asc" ? "asc" : "desc",
    offset: Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0,
    limit: PAGINATION.DEFAULT_PAGE_SIZE,
  };
}

/**
 * The same filter with search and status dropped.
 *
 * "Export all accounts" means every account, not every account matching what
 * happens to be typed in the search box. Sort order is kept so the file is in a
 * predictable sequence rather than the database's.
 */
export function withoutNarrowing(filter: ParsedAccountFilter): ParsedAccountFilter {
  return {
    sortBy: filter.sortBy,
    sortDirection: filter.sortDirection,
    offset: 0,
    limit: filter.limit,
  };
}
