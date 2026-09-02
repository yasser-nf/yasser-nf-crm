import type { Result } from "@/types/result";
import { runForEach, uniqueIds } from "@/utils/bulk";

/**
 * Bulk delete — the orchestration half.
 *
 * Deliberately free of `server-only`, a database and an audit context, exactly
 * as bulk-accounts.service.ts is. It knows what to report; it does not know how
 * to delete anything. The caller supplies that, and the only caller supplies
 * `softDeleteAccount` — the same function the single-account button already
 * calls, with the same permission check, the same soft delete and the same
 * audit entry.
 *
 * Injecting the deleter is what keeps this testable without a database, and
 * more importantly it is what stops a second deletion mechanism from existing:
 * there is nothing here that could drift from the real one.
 *
 * The loop itself lives in `@/utils/bulk`, shared with the bulk problem
 * operations. This file keeps the delete vocabulary — `deleted` rather than
 * `succeeded` — because that is the word the operator is shown.
 */

export type { BulkFailure as BulkDeleteFailure } from "@/utils/bulk";
export { uniqueIds };

export interface BulkDeleteReport {
  readonly deleted: readonly string[];
  readonly failed: readonly { readonly id: string; readonly message: string }[];
}

/** Deletes each account, one at a time, and reports both outcomes. */
export async function deleteEachAccount(
  ids: readonly string[],
  deleteOne: (id: string) => Promise<Result<unknown>>,
): Promise<BulkDeleteReport> {
  const outcome = await runForEach(ids, deleteOne);

  return { deleted: outcome.succeeded, failed: outcome.failed };
}
