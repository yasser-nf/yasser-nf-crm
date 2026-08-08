import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { customers } from "./customers";
import { profileEventTypeEnum } from "./enums";
import { profiles } from "./profiles";
import { users } from "./users";

/**
 * Profile history. Append-only.
 *
 * The M02 brief asks for this table to be designed for future extensibility,
 * which is why detail lives in a `data` jsonb column rather than in a widening
 * set of nullable columns. A `replaced` event needs the replacement profile, an
 * `extended` event needs the added days, a `pin_changed` event needs neither —
 * modelling all of that as columns would give every row a dozen nulls and every
 * new event type another migration.
 *
 * Distinct from the deferred timeline_events, which records ACCOUNT history.
 * Different grain, different table. See ADR-005 Decision 1.
 *
 * There is no updated_at and no deleted_at. 01_MASTER_RULES.md requires history
 * that is never modified, and a column that does not exist cannot be written to
 * by mistake.
 */
export const profileEvents = pgTable(
  "profile_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    profileId: uuid("profile_id")
      .notNull()
      /*
       * Cascade: profiles die with their account, and a profile's history has no
       * subject once the profile is gone. Account-level history is timeline_events'
       * job, and that table is deferred.
       */
      .references(() => profiles.id, { onDelete: "cascade" }),

    eventType: profileEventTypeEnum("event_type").notNull(),

    /**
     * Who did it. Null for events the system raises on its own, such as expiry
     * detected by a scheduled sweep.
     */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),

    /**
     * The customer this event concerned, when it concerned one.
     *
     * Set null on customer deletion: the event still happened and must survive,
     * even if the customer record does not.
     */
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),

    /**
     * Event-specific payload. The extensibility seam.
     *
     * Must never contain a password or any decrypted secret — this table is read
     * by history views and is not a place secrets should reach.
     */
    data: jsonb("data").notNull().default({}),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /*
     * The primary read: one profile's history, newest first. Descending in the
     * index so the query reads the front rather than sorting.
     */
    index("profile_events_profile_created_idx").on(table.profileId, table.createdAt.desc()),

    index("profile_events_type_idx").on(table.eventType),
    index("profile_events_customer_id_idx").on(table.customerId),
    index("profile_events_actor_user_id_idx").on(table.actorUserId),
    index("profile_events_created_at_idx").on(table.createdAt.desc()),
  ],
);

export type ProfileEventRow = typeof profileEvents.$inferSelect;
export type NewProfileEventRow = typeof profileEvents.$inferInsert;
