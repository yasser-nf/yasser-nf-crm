import { sql } from "drizzle-orm";
import { boolean, check, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { users } from "./users";

/**
 * Global application settings.
 *
 * 03_DATABASE.md: "One row only."
 *
 * That is enforced structurally rather than trusted. `singleton` is constrained
 * to true and carries a unique index, so a second row is rejected by the database
 * regardless of what any service does. Application-level "there should only be
 * one" checks lose races; this cannot.
 *
 * Values live in a jsonb column because no document defines a single concrete
 * setting. 01_MASTER_RULES.md forbids inventing business rules, so inventing
 * typed columns for settings nobody has specified would be worse than leaving the
 * shape open. As real settings are specified they should be promoted to typed
 * columns — jsonb is the honest placeholder, not the intended destination.
 */
export const settings = pgTable(
  "settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Singleton guard. Always true; the unique index below is what makes a second
     * row impossible.
     */
    singleton: boolean("singleton").notNull().default(true),

    values: jsonb("values").notNull().default({}),

    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("settings_singleton_unique").on(table.singleton),
    check("settings_singleton_true", sql`${table.singleton} = true`),
  ],
);

export type SettingsRow = typeof settings.$inferSelect;
export type NewSettingsRow = typeof settings.$inferInsert;
