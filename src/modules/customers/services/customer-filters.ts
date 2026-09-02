import { PAGINATION } from "@/config/constants";
import type { CustomerFilter, CustomerSortField } from "../repositories/customers.repository";

/**
 * Turning a query string into a customer filter.
 *
 * Lifted out of the customers page so the CSV export runs the identical parse —
 * "Export filtered customers" has to mean Active only and Blocked exactly as
 * the screen means them.
 *
 * Also the validation boundary: the export receives a query string from a
 * browser, so every value is matched against a known set before it reaches the
 * repository.
 */

export const CUSTOMER_SORT_FIELDS: readonly CustomerSortField[] = [
  "createdAt",
  "lastPurchaseAt",
  "phoneNormalized",
];

export type RawSearchParams = Record<string, string | string[] | undefined>;

function readParam(params: RawSearchParams, key: string): string | undefined {
  const value = params[key];

  return Array.isArray(value) ? value[0] : value;
}

/** The filter as the page needs it: sort and pagination always decided. */
export interface ParsedCustomerFilter extends CustomerFilter {
  readonly sortBy: CustomerSortField;
  readonly sortDirection: "asc" | "desc";
  readonly offset: number;
  readonly limit: number;
}

export function parseCustomerFilter(params: RawSearchParams): ParsedCustomerFilter {
  const offsetRaw = Number.parseInt(readParam(params, "offset") ?? "0", 10);
  const sortByRaw = readParam(params, "sortBy");

  return {
    search: readParam(params, "search"),
    onlyActive: readParam(params, "active") === "1",
    onlyBlocked: readParam(params, "blocked") === "1",
    sortBy: CUSTOMER_SORT_FIELDS.find((field) => field === sortByRaw) ?? "createdAt",
    sortDirection: readParam(params, "sortDirection") === "asc" ? "asc" : "desc",
    offset: Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0,
    limit: PAGINATION.DEFAULT_PAGE_SIZE,
  };
}

/**
 * The same filter with search and the status toggles dropped.
 *
 * "Export all customers" means every customer, not every customer matching
 * whatever is currently typed. Sort order is kept so the file has a predictable
 * sequence.
 */
export function withoutNarrowing(filter: ParsedCustomerFilter): ParsedCustomerFilter {
  return {
    sortBy: filter.sortBy,
    sortDirection: filter.sortDirection,
    offset: 0,
    limit: filter.limit,
  };
}
