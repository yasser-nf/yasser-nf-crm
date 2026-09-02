import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  pgTable,
  smallint,
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
     * How many of the five profile rows may be sold. 1 to 5.
     *
     * The account still HAS exactly five profiles — 01_MASTER_RULES.md forbids a
     * dynamic profile count and nothing here changes that. This says how many of
     * them are stock. Profiles numbered above it carry status `not_for_sale` and
     * are excluded from every allocation path.
     *
     * Defaulted to 5, so every account written before M13 keeps exactly the
     * behaviour it had and no backfill was needed.
     *
     * Changing it is an audited operation that also rewrites the affected
     * profile rows, in one transaction — see accountsService.setProfileSlots.
     * Nothing else in the codebase may write this column.
     */
    profileSlots: smallint("profile_slots").notNull().default(5),

    /**
     * The account's OWN coverage window, which is not the customer's.
     *
     * 03_DATABASE.md keeps allocation validity on profiles (sale_date,
     * expiration_date, duration_days). That answers "how long has this customer
     * paid for". These two answer "how long can this account serve anyone at
     * all", and the two are independent: an account with 30 days left cannot
     * cover a 90-day sale no matter what the customer paid.
     *
     * NULL means open-ended, NOT expired. The difference is load-bearing —
     * reading NULL as expired would have made every pre-M13 account instantly
     * unallocatable the moment this column appeared.
     *
     * `date` rather than `timestamp`, matching profiles.expiration_date: a
     * coverage boundary runs in whole days, and a timezone on one produces
     * off-by-one expiries at midnight.
     */
    validFrom: date("valid_from"),
    validUntil: date("valid_until"),

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
     * Partial index for the Smart Stock Engine hot path: the live accounts it
     * may choose from. It used to carry `health_score desc` as a second column,
     * to read the healthiest account off the front of the index. That column was
     * never calculated — every row held its default — so the ordering it
     * provided was no ordering at all, and the engine now ranks by status and
     * age instead.
     */
    index("accounts_stock_selection_idx")
      .on(table.status)
      .where(sql`${table.deletedAt} is null`),

    /*
     * Allocation reads this on every Quick Prepare and Quick Replace. Partial,
     * so it covers only the live rows the allocator can actually choose.
     */
    index("accounts_validity_idx")
      .on(table.validUntil)
      .where(sql`${table.deletedAt} is null`),

    /* An account can sell no more than the five rows it has, and no fewer than one. */
    check("accounts_profile_slots_range", sql`${table.profileSlots} between 1 and 5`),

    /* Coverage cannot end before it starts. Mirrors profiles_expiry_after_sale. */
    check(
      "accounts_validity_order",
      sql`${table.validUntil} is null or ${table.validFrom} is null or ${table.validUntil} >= ${table.validFrom}`,
    ),

    /*
     * Cheap guard against an obviously invalid address. Full validation is Zod's
     * job; this exists so a direct SQL insert cannot bypass it entirely.
     */
    check("accounts_email_shape", sql`${table.email} ~ '^[^@[:space:]]+@[^@[:space:]]+$'`),
  ],
);

export type AccountRow = typeof accounts.$inferSelect;
export type NewAccountRow = typeof accounts.$inferInsert;
