import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { accounts } from "./accounts";
import { customers } from "./customers";
import { profileStatusEnum } from "./enums";
import { users } from "./users";

/**
 * Netflix profiles.
 *
 * 01_MASTER_RULES.md: exactly five per account, numbered 1 to 5, never four,
 * never six, never dynamic.
 *
 * The database enforces what it can:
 *   - profile_number is constrained to 1..5
 *   - (account_id, profile_number) is unique
 *
 * Together those make six profiles impossible. They cannot make *four*
 * impossible: no declarative constraint can require that five sibling rows exist,
 * because each row is inserted separately and the table would be invalid between
 * the first and fifth insert.
 *
 * The M02 brief therefore states the rule is enforced by application logic. It
 * belongs in the service that creates an account, inside a single transaction
 * that writes the account and all five profiles together — so the count is never
 * observably wrong.
 */
export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    accountId: uuid("account_id")
      .notNull()
      /*
       * Cascade is correct here and only here. A profile has no meaning without
       * its account — this is composition, not association. Contrast customer_id
       * below, which is set null.
       */
      .references(() => accounts.id, { onDelete: "cascade" }),

    profileNumber: smallint("profile_number").notNull(),

    /** Netflix profile label. Changing it raises a `name_changed` event. */
    profileName: text("profile_name"),

    /** Netflix profile PIN. Searchable per 01_MASTER_RULES.md, so not encrypted. */
    pin: text("pin"),

    status: profileStatusEnum("status").notNull().default("available"),

    /**
     * The customer currently holding this profile, or null when available.
     *
     * Set null rather than cascade: deleting a customer must not delete the
     * profile, which belongs to the account and will simply become free.
     */
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),

    /** The worker who made the current sale. */
    workerId: uuid("worker_id").references(() => users.id, { onDelete: "set null" }),

    /**
     * `date` not `timestamp`: a subscription runs in whole days, and a timezone
     * on a sale date invites off-by-one expiry bugs at midnight.
     */
    saleDate: date("sale_date"),
    expirationDate: date("expiration_date"),

    /**
     * Named for its unit. 03_DATABASE.md called this `subscription_duration`,
     * which does not say days — ADR-005 Decision 6 records the rename.
     */
    durationDays: integer("duration_days"),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /* The half of the five-profile rule the database can enforce. */
    uniqueIndex("profiles_account_number_unique").on(table.accountId, table.profileNumber),

    index("profiles_account_id_idx").on(table.accountId),
    index("profiles_status_idx").on(table.status),
    index("profiles_customer_id_idx").on(table.customerId),
    index("profiles_worker_id_idx").on(table.workerId),
    index("profiles_pin_idx").on(table.pin),
    index("profiles_sale_date_idx").on(table.saleDate),

    /*
     * Expiry sweeps only ever look at profiles that have an expiry date, which is
     * a minority of a 500,000-row table. A partial index keeps that scan small.
     */
    index("profiles_expiration_date_idx")
      .on(table.expirationDate)
      .where(sql`${table.expirationDate} is not null`),

    /* Stock lookup: free profiles for a given account. */
    index("profiles_availability_idx")
      .on(table.accountId, table.status)
      .where(sql`${table.status} = 'available'`),

    check("profiles_number_range", sql`${table.profileNumber} between 1 and 5`),

    check(
      "profiles_duration_positive",
      sql`${table.durationDays} is null or ${table.durationDays} > 0`,
    ),

    /*
     * A subscription cannot end before it starts. Permits either date being null,
     * because an available profile has neither.
     */
    check(
      "profiles_expiry_after_sale",
      sql`${table.saleDate} is null or ${table.expirationDate} is null or ${table.expirationDate} >= ${table.saleDate}`,
    ),

    /*
     * A held profile must say who holds it, and an available one must not.
     *
     * This is the integrity rule most likely to be broken by a partially
     * completed operation, and the hardest to notice afterwards — an available
     * profile still pointing at a customer looks fine in a list and silently
     * double-sells.
     *
     * `expired` is deliberately unconstrained. Whether an expired profile keeps
     * its customer for history or is cleared on recycling is a business rule no
     * document states, and 01_MASTER_RULES.md forbids inventing one.
     */
    check(
      "profiles_held_requires_customer",
      sql`(${table.status} in ('sold', 'reserved', 'expiring_soon') and ${table.customerId} is not null)
          or (${table.status} = 'available' and ${table.customerId} is null)
          or ${table.status} = 'expired'`,
    ),
  ],
);

export type ProfileRow = typeof profiles.$inferSelect;
export type NewProfileRow = typeof profiles.$inferInsert;
