import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { users } from "./users";

/**
 * External suppliers. M10.
 *
 * An account is either ours or bought from somebody. `accounts.supplier_id`
 * names who, and NULL means "My Account" — ours. There is deliberately no
 * sentinel "MY ACCOUNT" supplier row: a fake supplier would be editable,
 * deactivatable and countable like a real one, and every query would have to
 * remember to exclude it. NULL cannot be renamed or archived by mistake.
 *
 * A SUPPLIER BELONGS TO AN ACCOUNT, NEVER TO A PROFILE.
 *
 * The M10 brief is explicit, and the data model already agrees: a profile has
 * no meaning outside its account (see profiles.ts), so a profile's supplier is
 * its account's supplier and storing it twice would be duplicate state that
 * drifts the moment an account is reassigned. There is no supplier column on
 * profiles and there must never be one.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * Passwords, payment details, API keys, contact credentials, prices. M10 §4
 * excludes them and nothing in this milestone needs them. A supplier row is
 * safe to read by any CRM user, which is what lets the RLS read policy be
 * `is_crm_user()` rather than admin-only.
 */
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** As the operator typed it. Shown everywhere; never matched on. */
    name: text("name").notNull(),

    /**
     * The name reduced to its comparable form: lower-cased, with runs of
     * whitespace collapsed. Written by the service through
     * `normalizeSupplierName` and matched by the unique index below.
     *
     * A stored column rather than a functional index, mirroring
     * `customers.phone_normalized` — the one existing precedent for "the same
     * identity typed two ways". M10 §5: "Supplier A" and " supplier  a " are
     * one supplier, and the database is what guarantees it rather than a check
     * some future caller forgets.
     */
    nameNormalized: text("name_normalized").notNull(),

    notes: text("notes"),

    /**
     * When this supplier was deactivated, or null while active.
     *
     * A timestamp rather than a status enum, following `customers.blocked_at`
     * and `customers.deleted_at`, whose status is likewise derived
     * (`deriveCustomerStatus`). It records WHEN as well as whether, which a
     * boolean or an enum cannot, and it avoids adding a two-value enum that
     * PostgreSQL could not later shrink — the rollback hazard ADR-013 recorded.
     *
     * There is no `deleted_at` and no delete path. M10 §6 and §24 prefer
     * deactivation, and accounts keep pointing at a deactivated supplier
     * (§23), so a tombstone would describe a state the application never
     * reaches.
     */
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),

    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * One supplier per name, however it was typed.
     *
     * NOT partial. There is no soft delete here, and a deactivated supplier
     * keeps its name: creating a second "Supplier A" while the first is merely
     * inactive would make the accounts of each indistinguishable on screen,
     * which is the confusion M10 §23 exists to prevent by keeping the old one
     * visible.
     */
    uniqueIndex("suppliers_name_normalized_unique").on(table.nameNormalized),

    /** The management list orders by name; the dashboard reads active ones. */
    index("suppliers_name_idx").on(table.name),
    index("suppliers_active_idx").on(table.deactivatedAt),

    /* Mirrors the Zod rule, so a direct SQL insert cannot store a blank name. */
    check("suppliers_name_not_empty", sql`length(trim(${table.name})) > 0`),
    check("suppliers_name_normalized_not_empty", sql`length(${table.nameNormalized}) > 0`),
  ],
);

export type SupplierRow = typeof suppliers.$inferSelect;
export type NewSupplierRow = typeof suppliers.$inferInsert;
