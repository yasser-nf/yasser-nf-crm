import { and, eq } from "drizzle-orm";

import { databaseAdapter, type DatabaseTransaction } from "@/lib/database";
import { idempotencyKeys, type IdempotencyKeyRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";

/**
 * Receipts for business operations (M08 jobs). Two writes, both inside the
 * operation's own transaction, and one read outside it.
 */

export interface ReceiptIdentity {
  readonly scope: string;
  readonly key: string;
}

export interface NewReceipt extends ReceiptIdentity {
  readonly requestHash: string;
  readonly actorId: string | null;
}

export interface IdempotencyRepository {
  /**
   * Inserts the receipt, or returns the one already committed under that key.
   *
   * `ON CONFLICT DO NOTHING` on the primary key: if another transaction holds
   * an uncommitted row with the same key, PostgreSQL makes this statement wait
   * for it. If it commits, this one does nothing and the SELECT reads the
   * committed row; if it rolls back, this one inserts. Never two receipts.
   */
  claim(
    executor: DatabaseTransaction,
    receipt: NewReceipt,
  ): Promise<
    { readonly claimed: true } | { readonly claimed: false; readonly existing: IdempotencyKeyRow }
  >;

  /** Records what the operation did. Same transaction as the operation. */
  setResult(
    executor: DatabaseTransaction,
    identity: ReceiptIdentity,
    result: Record<string, unknown>,
  ): Promise<void>;

  /** A committed receipt, if any. */
  find(identity: ReceiptIdentity): Promise<Result<IdempotencyKeyRow | null>>;

  /** The same read on the caller's transaction (stale-job recovery). */
  findWith(
    executor: DatabaseTransaction,
    identity: ReceiptIdentity,
  ): Promise<IdempotencyKeyRow | null>;
}

function matches(identity: ReceiptIdentity) {
  return and(eq(idempotencyKeys.scope, identity.scope), eq(idempotencyKeys.key, identity.key));
}

export const idempotencyRepository: IdempotencyRepository = {
  async claim(executor, receipt) {
    const inserted = await executor
      .insert(idempotencyKeys)
      .values({
        scope: receipt.scope,
        key: receipt.key,
        requestHash: receipt.requestHash,
        actorId: receipt.actorId,
      })
      .onConflictDoNothing()
      .returning({ scope: idempotencyKeys.scope });

    if (inserted.length > 0) {
      return { claimed: true };
    }

    const [existing] = await executor.select().from(idempotencyKeys).where(matches(receipt));

    if (!existing) {
      /* The conflicting row vanished between the two statements: only a rollback does that. */
      throw new Error("Idempotency receipt conflict could not be resolved");
    }

    return { claimed: false, existing };
  },

  async setResult(executor, identity, result) {
    await executor.update(idempotencyKeys).set({ result }).where(matches(identity));
  },

  async findWith(executor, identity) {
    const [row] = await executor.select().from(idempotencyKeys).where(matches(identity));
    return row ?? null;
  },

  async find(identity) {
    return databaseAdapter.query("idempotency.find", async (executor) => {
      const [row] = await executor.select().from(idempotencyKeys).where(matches(identity));
      return row ?? null;
    });
  },
};
