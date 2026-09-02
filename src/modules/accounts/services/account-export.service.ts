import "server-only";

import { PAGINATION } from "@/config/constants";
import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { ACCOUNT_EXPORT_HEADERS, accountToCsvRow } from "./account-csv";
import { parseAccountFilter, withoutNarrowing, type RawSearchParams } from "./account-filters";
import { accountsService, type AccountListRow } from "./accounts.service";

/**
 * Building the accounts CSV.
 *
 * Reads through `accountsService.listAccounts` — the same call the accounts
 * page makes, with a filter produced by the same parser — so the file contains
 * the same rows, the same tallies and the same labels the operator was looking
 * at. Nothing here queries a table or counts anything.
 */

export type AccountExportScope = "all" | "filtered" | "selected";

export interface ExportResult {
  readonly csv: string;
  readonly rowCount: number;
}

/**
 * A ceiling on one export.
 *
 * The loop below pages until it has everything, and "everything" is decided by
 * a row count from the database. This stops a runaway query from building a
 * string the server cannot hold, and is far above any plausible inventory for
 * this CRM.
 */
const MAX_EXPORT_ROWS = 10_000;

/** Read a page at a time; the pool holds three connections, so never in parallel. */
const PAGE_SIZE = PAGINATION.MAX_PAGE_SIZE;

/**
 * Every account matching the filter, not just the page on screen.
 *
 * Sequential paging. The alternative — asking the repository for one enormous
 * page — would need a new query path with different clamping, and the point of
 * this feature is that there is no second way to read accounts.
 */
async function collectRows(
  filter: ReturnType<typeof parseAccountFilter>,
): Promise<Result<AccountListRow[]>> {
  const rows: AccountListRow[] = [];
  let offset = 0;

  for (;;) {
    const page = await accountsService.listAccounts({ ...filter, offset, limit: PAGE_SIZE });

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
 * Builds the CSV for one of the three scopes.
 *
 * Authorization first, and by the same permission the accounts page requires.
 * A Server Action is a POST endpoint: hiding the Export button protects
 * nothing, so the check happens here rather than in the component.
 *
 * `params` is the page's own query string. It is parsed server-side by
 * `parseAccountFilter`, which matches every value against a known set — so a
 * hand-written request cannot reach a column or a status the screen would not.
 */
async function exportAccounts(
  actor: AppUser | null,
  scope: unknown,
  params: unknown,
  selectedIds: unknown,
): Promise<Result<ExportResult>> {
  if (!actor) {
    return fail(new ForbiddenError("No signed-in user for an account export"));
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.VIEW_ACCOUNTS)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not export accounts`, {
        userMessage: "You do not have permission to view accounts.",
        context: { actorId: actor.id, role: actor.role },
      }),
    );
  }

  if (scope !== "all" && scope !== "filtered" && scope !== "selected") {
    return fail(
      new ValidationError(`Unknown export scope ${String(scope)}`, {
        userMessage: "That export option is not available.",
      }),
    );
  }

  const raw: RawSearchParams =
    typeof params === "object" && params !== null ? (params as RawSearchParams) : {};

  const parsed = parseAccountFilter(raw);
  /* "All" deliberately drops the search box and the status filter. */
  const filter = scope === "all" ? withoutNarrowing(parsed) : { ...parsed, offset: 0 };

  const collected = await collectRows(filter);

  if (!collected.ok) {
    return collected;
  }

  let rows = collected.value;

  if (scope === "selected") {
    if (!Array.isArray(selectedIds) || selectedIds.some((id) => typeof id !== "string")) {
      return fail(
        new ValidationError("Selected export received something other than a list of ids", {
          userMessage: "Select at least one account first.",
        }),
      );
    }

    /*
     * An intersection, not a lookup by id.
     *
     * The selected rows are taken from the same filtered result the operator is
     * looking at, so the export cannot include an account that is not in their
     * current view — and a hand-written id for something outside it simply
     * matches nothing rather than fetching it.
     */
    const wanted = new Set(selectedIds as string[]);
    rows = rows.filter((row) => wanted.has(row.account.id));
  }

  return ok({
    csv: toCsv(ACCOUNT_EXPORT_HEADERS, rows.map(accountToCsvRow)),
    rowCount: rows.length,
  });
}

export const accountExportService = { exportAccounts } as const;
