import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { accountStatusEnum } from "./enums";
import { users } from "./users";

/**
 * Netflix accounts.
 *
 * 01_MASTER_RULES.md: each account always contains exactly five profiles. That
 * rule is enforced in the service layer, not here — see profiles.ts for why a
 * database constraint cannot express it.
 *
 * Business rule this table participates in: if `status` is not `healthy`, ALL of
 * this account's profiles become unavailable, with no exceptions. Availability is
 * therefore always a function of account status and profile status together, and
 * must never be read from profile status alone.
 *
 * `subscription_type` is deliberately absent. CURRENT_MILESTONE.md listed it, but
 * no document defines its permitted values, and 01_MASTER_RULES.md forbids
 * inventing business rules. See ADR-005 Decision 6.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    email: text("email").notNull(),

    /**
     * AES-256-GCM ciphertext in the form `v1:<iv>:<tag>:<data>`.
     *
     * ADR-005 Decision 4. Never selected into anything a client can reach, and
     * never logged. Encrypting the same password twice yields different
     * ciphertext, so this column cannot be compared or indexed for equality —
     * which is why search by password requires decrypt-then-filter.
     */
    passwordEncrypted: text("password_encrypted").notNull(),

    status: accountStatusEnum("status").notNull().default("healthy"),

    /**
     * 0–100, used by the Smart Stock Engine.
     *
     * 01_MASTER_RULES.md forbids returning problematic accounts and requires
     * scoring rather than picking the first match. The scoring formula belongs to
     * that engine's milestone; this column only stores the result.
     */
    healthScore: integer("health_score").notNull().default(100),

    country: text("country"),
    notes: text("notes"),

    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * Two distinct lifecycle timestamps, matching two distinct statuses in
     * 01_MASTER_RULES.md. Archived is reversible and retains the account for
     * reference; deleted is the soft-delete tombstone.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    /*
     * 03_DATABASE.md: "Only one active record per email." Scoped to live rows so
     * a deleted account does not permanently burn its address — the same Netflix
     * email can legitimately be re-registered later.
     */
    uniqueIndex("accounts_email_unique_live")
      .on(table.email)
      .where(sql`${table.deletedAt} is null`),

    index("accounts_status_idx").on(table.status),
    index("accounts_created_at_idx").on(table.createdAt),
    index("accounts_created_by_idx").on(table.createdBy),
    index("accounts_country_idx").on(table.country),

    /*
     * Partial composite index for the Smart Stock Engine's hot path: find the
     * healthiest live account. Ordering by score descending inside the index
     * means the engine reads the front of it rather than sorting.
     */
    index("accounts_stock_selection_idx")
      .on(table.status, table.healthScore.desc())
      .where(sql`${table.deletedAt} is null`),

    check("accounts_health_score_range", sql`${table.healthScore} between 0 and 100`),

    /*
     * Cheap guard against an obviously invalid address. Full validation is Zod's
     * job; this exists so a direct SQL insert cannot bypass it entirely.
     */
    check("accounts_email_shape", sql`${table.email} ~ '^[^@[:space:]]+@[^@[:space:]]+$'`),
  ],
);

export type AccountRow = typeof accounts.$inferSelect;
export type NewAccountRow = typeof accounts.$inferInsert;
