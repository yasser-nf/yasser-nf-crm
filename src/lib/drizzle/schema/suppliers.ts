import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { users } from "./users";

/**
 * Account suppliers (M09B).
 *
 * Some Netflix accounts are the business's own; others come from an outside
 * supplier. This table is the supplier side of that relationship — the account
 * side is `accounts.ownership` and `accounts.supplier_id`.
 *
 * The NAME is the only thing required to record a supplier. Demanding a phone
 * number or an address before an operator can write down who an account came
 * from would mean the relationship goes unrecorded, which is the thing this
 * table exists to prevent. `contact` is deliberately free text: suppliers are
 * reached by whatever they use — a number, a Telegram handle, an email — and
 * the phone engine that normalises CUSTOMER identities would be the wrong
 * instrument here.
 *
 * Soft-deleted and archivable like accounts, so a supplier that stops trading
 * keeps its history rather than taking its accounts' provenance with it.
 */
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    name: text("name").notNull(),

    /** Free text: a number, a handle, an email — whatever reaches them. */
    contact: text("contact"),

    notes: text("notes"),

    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

    /** Hidden from pickers, still named by its accounts. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    /*
     * One supplier per name among the live ones, compared case- and
     * space-insensitively: "Ahmed", "ahmed" and " Ahmed " are one supplier,
     * and two rows for the same person would split their accounts across two
     * sets of figures. Partial on deleted_at, exactly as the customers' phone
     * index is, so a deleted name can be used again.
     */
    uniqueIndex("suppliers_name_unique_live")
      .on(sql`lower(btrim(${table.name}))`)
      .where(sql`${table.deletedAt} is null`),

    index("suppliers_name_idx").on(table.name),
    index("suppliers_created_by_idx").on(table.createdBy),

    check("suppliers_name_not_empty", sql`length(btrim(${table.name})) between 1 and 120`),
    check(
      "suppliers_contact_length",
      sql`${table.contact} is null or length(${table.contact}) <= 200`,
    ),
  ],
);

export type SupplierRow = typeof suppliers.$inferSelect;
export type NewSupplierRow = typeof suppliers.$inferInsert;
