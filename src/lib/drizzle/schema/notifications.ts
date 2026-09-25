import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { users } from "./users";

/**
 * In-app notifications (M05).
 *
 * The table ADR-005 Decision 1 deferred. One row is one message to one person:
 * "a problem was assigned to you". It is the smallest shape that can carry an
 * actionable notice — who it is for, what happened, what it points at, and
 * whether it has been read — and nothing else. No channels, no templates, no
 * delivery state: M05 is application notifications only.
 *
 * Content is a snapshot. The title and body say what was true when the event
 * happened, the way a message does; they are not re-derived on read. That is
 * also why they must never carry a credential — a PIN or password written here
 * would outlive every redaction applied to the table it came from.
 *
 * `entity_type` / `entity_id` locate the thing to open. Deliberately not a
 * foreign key: one column cannot reference several tables. The service turns
 * the pair into a route from a closed list, so a row can only ever link to a
 * page the application knows.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Who it is for. A notification dies with its recipient's user row. */
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** Who caused it. Kept after they leave, like the rest of the history. */
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),

    /** The event. A closed set, enforced by the check constraint below. */
    type: text("type").notNull(),

    title: text("title").notNull(),
    body: text("body"),

    entityType: text("entity_type"),
    entityId: uuid("entity_id"),

    /**
     * Identifies the EVENT, not the row: the same event delivered twice to the
     * same person is one notification. Unique per recipient, so a retried
     * operation, or two code paths reporting one occurrence, cannot stack
     * duplicates — the second insert is a no-op.
     */
    dedupeKey: text("dedupe_key").notNull(),

    /** Null while unread. A timestamp rather than a flag: when it was read is free. */
    readAt: timestamp("read_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /* The panel: one person's newest first. */
    index("notifications_recipient_created_idx").on(table.recipientId, table.createdAt.desc()),

    /*
     * The badge: one person's unread count. Partial, so it stays as small as
     * the unread set however long the read history grows.
     */
    index("notifications_unread_idx")
      .on(table.recipientId)
      .where(sql`${table.readAt} is null`),

    /* Removing a problem removes the notices that would link to nothing. */
    index("notifications_entity_idx").on(table.entityType, table.entityId),

    uniqueIndex("notifications_recipient_dedupe_unique").on(table.recipientId, table.dedupeKey),

    check(
      "notifications_type_known",
      sql`${table.type} in ('problem_reported', 'problem_assigned', 'problem_resolved', 'problem_reopened')`,
    ),
    check("notifications_title_not_empty", sql`length(trim(${table.title})) > 0`),
    check(
      "notifications_entity_complete",
      sql`(${table.entityType} is null) = (${table.entityId} is null)`,
    ),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;
