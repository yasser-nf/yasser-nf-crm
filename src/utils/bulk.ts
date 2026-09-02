import type { Result } from "@/types/result";

/**
 * Running one operation over many records, and reporting both outcomes.
 *
 * Extracted from the bulk account delete once the problems module needed the
 * same shape. The loop is the part worth sharing: what "keep going after a
 * failure" and "say which ones failed" mean does not change between deleting an
 * account, declaring a problem on it, or resolving one.
 *
 * Pure, and knows nothing about what it is running. The caller supplies the
 * operation, which in every case is a function that already exists and already
 * carries its own permission check and audit entry.
 */

/** One record the operation refused, and why. */
export interface BulkFailure {
  readonly id: string;
  /** Already a `userMessage` — safe to show. Never a technical cause. */
  readonly message: string;
}

export interface BulkOutcome {
  readonly succeeded: readonly string[];
  readonly failed: readonly BulkFailure[];
}

/**
 * Ids in their original order, with duplicates removed.
 *
 * A repeated id would otherwise be operated on twice, writing two audit entries
 * for one act and inflating the count the operator is shown.
 */
export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Runs the operation against each id, one at a time.
 *
 * Partial success is the designed behaviour. These are independent records
 * rather than steps in one transaction, and an operator who selected six
 * accounts where one is protected by a business rule is far better served by
 * "five done, this one refused because …" than by having all six silently do
 * nothing.
 *
 * Sequential rather than `Promise.all`. Each operation also writes an audit
 * row, so a parallel burst would take two pooled connections per record against
 * a pool of three, and the audit trail would stop matching the order the
 * operator chose.
 *
 * Nothing throws: a rejected operation is recorded and the loop continues, so
 * one failure can never abandon the records after it.
 */
export async function runForEach(
  ids: readonly string[],
  operation: (id: string) => Promise<Result<unknown>>,
): Promise<BulkOutcome> {
  const succeeded: string[] = [];
  const failed: BulkFailure[] = [];

  for (const id of uniqueIds(ids)) {
    const outcome = await operation(id);

    if (outcome.ok) {
      succeeded.push(id);
    } else {
      failed.push({ id, message: outcome.error.userMessage });
    }
  }

  return { succeeded, failed };
}
