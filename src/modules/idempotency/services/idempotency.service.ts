import "server-only";

import { createHash } from "node:crypto";

import type { DatabaseTransaction } from "@/lib/database";
import { ConflictError, isAppError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { idempotencyRepository } from "../repositories/idempotency.repository";

/**
 * At-most-once business operations (M08 jobs). docs/JOBS_MODULE.md §6.
 *
 *   const operation = idempotency.operation(scope, key, actorId, request);
 *
 *   const prior = await idempotency.lookup(operation);       // cheap pre-check
 *   if (prior.value) return replay(prior.value);
 *
 *   await databaseAdapter.transaction(…, async (tx) => {
 *     await idempotency.begin(tx, operation);                 // FIRST write
 *     … the business mutation …
 *     await idempotency.complete(tx, operation, references);  // same transaction
 *   });
 *   // a failure that `isReplay` recognises carries the committed receipt
 *
 * The pre-check is an optimisation; `begin` is the guarantee. Whatever the
 * timing — a double click, a network retry, the adapter retrying a
 * transaction whose COMMIT acknowledgement was lost, a job worker retrying
 * after a crash — the receipt and the business rows commit together or not at
 * all, so a committed operation is never performed twice.
 *
 * The key alone is not trusted: it is bound to the actor and to a hash of the
 * request. Reusing a key for a different request, or someone else's key, is
 * refused — not replayed.
 */

export interface Operation {
  readonly scope: string;
  readonly key: string;
  readonly actorId: string | null;
  readonly requestHash: string;
}

export interface Receipt {
  readonly scope: string;
  readonly key: string;
  readonly result: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

/**
 * The operation already committed: here is what it did.
 *
 * A ConflictError so it crosses `databaseAdapter.transaction` intact (AppErrors
 * are returned as they are) and rolls back the empty transaction that found it.
 * Callers that understand replays check `isReplay`; any other caller sees a
 * conflict, which is the honest answer.
 */
export class IdempotentReplay extends ConflictError {
  constructor(readonly receipt: Receipt) {
    super(`Operation ${receipt.scope} already completed`, {
      userMessage: "This was already done.",
      context: { scope: receipt.scope },
    });
  }
}

export function isReplay(error: unknown): error is IdempotentReplay {
  return error instanceof IdempotentReplay;
}

/** JSON with object keys sorted, so equal requests hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(",")}}`;
  }

  return JSON.stringify(value ?? null);
}

export function requestHash(request: unknown): string {
  return createHash("sha256").update(canonical(request), "utf8").digest("hex");
}

function operation(
  scope: string,
  key: string,
  actorId: string | null,
  request: unknown,
): Operation {
  return { scope, key, actorId, requestHash: requestHash(request) };
}

function refuseMismatch(reason: "actor" | "request"): ConflictError {
  return new ConflictError(`Idempotency key reused for a different ${reason}`, {
    userMessage:
      reason === "actor"
        ? "This confirmation belongs to another user's request. Start again."
        : "This confirmation was already used for a different request. Start again.",
    context: { idempotencyMismatch: reason },
  });
}

/** Turns a committed row into a receipt, or refuses a mismatched reuse. */
function receiptFor(
  row: {
    scope: string;
    key: string;
    requestHash: string;
    actorId: string | null;
    result: Record<string, unknown> | null;
    createdAt: Date;
  },
  expected: Operation,
): Receipt {
  if (row.actorId !== expected.actorId) {
    throw refuseMismatch("actor");
  }

  if (row.requestHash !== expected.requestHash) {
    throw refuseMismatch("request");
  }

  return { scope: row.scope, key: row.key, result: row.result ?? {}, createdAt: row.createdAt };
}

/** A committed receipt for this operation, or null. Outside any transaction. */
async function lookup(expected: Operation): Promise<Result<Receipt | null>> {
  const row = await idempotencyRepository.find(expected);

  if (!row.ok) {
    return row;
  }

  if (!row.value) {
    return ok(null);
  }

  try {
    return ok(receiptFor(row.value, expected));
  } catch (caught) {
    return fail(isAppError(caught) ? caught : refuseMismatch("request"));
  }
}

/**
 * Claims the operation inside its transaction. Throws `IdempotentReplay` when
 * it already committed (rolling this transaction back), or a ConflictError for
 * a mismatched reuse.
 */
async function begin(executor: DatabaseTransaction, expected: Operation): Promise<void> {
  const claimed = await idempotencyRepository.claim(executor, expected);

  if (!claimed.claimed) {
    throw new IdempotentReplay(receiptFor(claimed.existing, expected));
  }
}

/**
 * Records what the operation did — references only. Inside the same
 * transaction, so the receipt never says more than what committed.
 */
async function complete(
  executor: DatabaseTransaction,
  expected: Operation,
  result: Record<string, unknown>,
): Promise<void> {
  await idempotencyRepository.setResult(executor, expected, result);
}

/**
 * Whether an operation with this scope and key has committed — the question
 * stale-job recovery asks before it decides to retry. Runs on the caller's
 * transaction. No actor or request check: recovery is not a request, it only
 * needs to know whether the work is already done.
 */
async function committed(
  executor: DatabaseTransaction,
  identity: { readonly scope: string; readonly key: string },
): Promise<boolean> {
  return (await idempotencyRepository.findWith(executor, identity)) !== null;
}

export const idempotency = { operation, lookup, begin, complete, committed } as const;
