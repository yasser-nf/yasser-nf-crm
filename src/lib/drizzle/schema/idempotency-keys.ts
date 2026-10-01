import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./users";

/**
 * Business-operation receipts (M08 jobs). docs/JOBS_MODULE.md §6.
 *
 * One row per business operation that must happen at most once — a Quick
 * Prepare sale, a Quick Replace — keyed by `(scope, key)`. The row is inserted
 * INSIDE the operation's own transaction, as its first write, so it commits if
 * and only if the operation commits:
 *
 *   - a repeat (double click, network retry, the adapter retrying after a
 *     commit whose acknowledgement was lost, a job worker retrying after a
 *     crash) finds the committed row and replays the original outcome instead
 *     of doing the work again;
 *   - a repeat that arrives while the first is still running waits on the
 *     primary key and then finds the row — PostgreSQL's unique-index semantics,
 *     not application timing;
 *   - an operation that rolls back leaves no row, so a genuine retry proceeds.
 *
 * `request_hash` binds the key to what was asked: the same key with a
 * different request is refused, not replayed. `result` holds references to
 * what was done (ids, dates) — never credentials. A replay re-derives anything
 * sensitive from the live records, with the same checks as the original.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    /** The operation family, e.g. `quick_prepare.confirm`. */
    scope: text("scope").notNull(),

    /** The operation's key within its scope. */
    key: text("key").notNull(),

    /** SHA-256 of the canonical request. */
    requestHash: text("request_hash").notNull(),

    /** Who performed it. A replay by someone else is refused. */
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),

    /** References to what the operation did; set before its transaction commits. */
    result: jsonb("result").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "idempotency_keys_pkey", columns: [table.scope, table.key] }),
    index("idempotency_keys_actor_idx").on(table.actorId),
    index("idempotency_keys_created_idx").on(table.createdAt),
    check(
      "idempotency_keys_scope_format",
      sql`${table.scope} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$' and length(${table.scope}) <= 64`,
    ),
    check("idempotency_keys_key_length", sql`length(${table.key}) between 1 and 200`),
    check("idempotency_keys_request_hash_format", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "idempotency_keys_result_size",
      sql`${table.result} is null or (jsonb_typeof(${table.result}) = 'object' and pg_column_size(${table.result}) <= 8192)`,
    ),
  ],
);

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
