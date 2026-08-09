import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Customers.
 *
 * 01_MASTER_RULES.md: customer uniqueness is determined by the normalized
 * WhatsApp number, not by name or by the number as typed.
 *
 *   +213 663 94 71 16  →  663947116
 *
 * All three forms are stored deliberately, and this is the one place
 * 03_DATABASE.md's "never duplicate information" rule is knowingly bent:
 *
 *   phone_original    what the operator typed — needed to show them back what
 *                     they entered, and to debug a bad normalisation
 *   phone_normalized  the identity key, and the only unique column
 *   whatsapp_url      derived, but stored so a click-to-chat link never depends
 *                     on regenerating it correctly at read time
 *
 * The Phone Engine owns normalisation. No feature normalises a number itself.
 */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    name: text("name"),

    phoneOriginal: text("phone_original").notNull(),
    phoneNormalized: text("phone_normalized").notNull(),
    whatsappUrl: text("whatsapp_url").notNull(),

    notes: text("notes"),

    /**
     * Purchase bookends.
     *
     * Derivable from orders once that table exists, but kept here because the
     * customer list needs them for sorting and the derivation would be a
     * correlated subquery per row against millions of orders.
     */
    firstPurchaseAt: timestamp("first_purchase_at", { withTimezone: true }),
    lastPurchaseAt: timestamp("last_purchase_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * The only stored piece of customer status.
     *
     * M05 defines four statuses. Three are derivable and therefore not stored:
     * Archived is `deleted_at`, Active means holding a live subscription, and
     * Inactive is the absence of one. Storing those would duplicate state and go
     * stale the moment a subscription expired on its own.
     *
     * Blocked is a human decision that nothing else can be inferred from, so it
     * is the one that needs a column.
     */
    blockedAt: timestamp("blocked_at", { withTimezone: true }),

    /** Soft delete: a customer may be referenced by profile history. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    /*
     * The uniqueness rule from 01_MASTER_RULES.md, scoped to live rows so a
     * returning customer can be re-added after deletion.
     */
    uniqueIndex("customers_phone_normalized_unique_live")
      .on(table.phoneNormalized)
      .where(sql`${table.deletedAt} is null`),

    index("customers_phone_original_idx").on(table.phoneOriginal),
    index("customers_name_idx").on(table.name),
    index("customers_created_at_idx").on(table.createdAt),
    index("customers_last_purchase_at_idx").on(table.lastPurchaseAt),

    /*
     * Guards against an empty or unnormalised key reaching the identity column.
     * Digits only — the normalised form of +213 663 94 71 16 is 663947116.
     */
    check("customers_phone_normalized_digits", sql`${table.phoneNormalized} ~ '^[0-9]{6,20}$'`),
  ],
);

export type CustomerRow = typeof customers.$inferSelect;
export type NewCustomerRow = typeof customers.$inferInsert;
