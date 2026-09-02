import "server-only";

import { PAGINATION } from "@/config/constants";
import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import type { CustomerWithStats } from "../repositories/customers.repository";
import { CUSTOMER_EXPORT_HEADERS, customerToCsvRow } from "./customer-csv";
import { parseCustomerFilter, withoutNarrowing, type RawSearchParams } from "./customer-filters";
import { customersService } from "./customers.service";

/**
 * Building the customers CSV.
 *
 * Reads through `customersService.list` with a filter from the same parser the
 * customers page uses, so Active only and Blocked mean exactly what they mean
 * on screen and the tallies are the ones already aggregated in SQL.
 */

export type CustomerExportScope = "all" | "filtered";

export interface ExportResult {
  readonly csv: string;
  readonly rowCount: number;
}

const MAX_EXPORT_ROWS = 10_000;
const PAGE_SIZE = PAGINATION.MAX_PAGE_SIZE;

async function collectRows(
  filter: ReturnType<typeof parseCustomerFilter>,
): Promise<Result<CustomerWithStats[]>> {
  const rows: CustomerWithStats[] = [];
  let offset = 0;

  for (;;) {
    const page = await customersService.list({ ...filter, offset, limit: PAGE_SIZE });

    if (!page.ok) {
      return page;
    }

    rows.push(...page.value.items);

    const exhausted = page.value.items.length === 0 || rows.length >= page.value.total;

    if (exhausted || rows.length >= MAX_EXPORT_ROWS) {
      break;
    }

    offset += PAGE_SIZE;
  }

  return ok(rows.slice(0, MAX_EXPORT_ROWS));
}

/**
 * Builds the CSV for one of the two scopes.
 *
 * Authorization by the same permission the customers page requires, checked
 * here because a Server Action is a POST endpoint and a hidden button protects
 * nothing.
 */
async function exportCustomers(
  actor: AppUser | null,
  scope: unknown,
  params: unknown,
): Promise<Result<ExportResult>> {
  if (!actor) {
    return fail(new ForbiddenError("No signed-in user for a customer export"));
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.VIEW_CUSTOMERS)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not export customers`, {
        userMessage: "You do not have permission to view customers.",
        context: { actorId: actor.id, role: actor.role },
      }),
    );
  }

  if (scope !== "all" && scope !== "filtered") {
    return fail(
      new ValidationError(`Unknown export scope ${String(scope)}`, {
        userMessage: "That export option is not available.",
      }),
    );
  }

  const raw: RawSearchParams =
    typeof params === "object" && params !== null ? (params as RawSearchParams) : {};

  const parsed = parseCustomerFilter(raw);
  const filter = scope === "all" ? withoutNarrowing(parsed) : { ...parsed, offset: 0 };

  const collected = await collectRows(filter);

  if (!collected.ok) {
    return collected;
  }

  /* One clock for the whole file, so no two rows straddle midnight. */
  const today = new Date();

  return ok({
    csv: toCsv(
      CUSTOMER_EXPORT_HEADERS,
      collected.value.map((row) => customerToCsvRow(row, today)),
    ),
    rowCount: collected.value.length,
  });
}

export const customerExportService = { exportCustomers } as const;
