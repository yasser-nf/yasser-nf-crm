import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { auditActionEnum, auditEntityEnum } from "./enums";
import { users } from "./users";

/**
 * Immutable system audit log.
 *
 * 01_MASTER_RULES.md: every important action is logged, logs are never deleted,
 * never modified, and the log is immutable.
 *
 * Immutability is expressed in three ways here:
 *   - no updated_at column
 *   - no deleted_at column
 *   - user_id is SET NULL rather than CASCADE on user deletion
 *
 * That last one is the important one. Cascading would let deleting a user erase
 * the record of what they did, which is exactly what an audit log exists to
 * prevent. The actor's email is copied into actor_email so the entry stays
 * meaningful after the user row is gone.
 *
 * A database-level guarantee (a REVOKE UPDATE/DELETE, or a trigger) would be
 * stronger than convention. It requires decisions about which database role the
 * application connects as, so it is recorded as outstanding rather than guessed
 * at.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    entity: auditEntityEnum("entity").notNull(),

    /**
     * The affected row's id. Deliberately not a foreign key: the log must
     * outlive the row it describes, and a delete entry would otherwise be
     * impossible to write.
     */
    entityId: uuid("entity_id").notNull(),

    action: auditActionEnum("action").notNull(),

    /**
     * State before and after. Null on create and delete respectively.
     *
     * Must never contain password_encrypted or any decrypted secret. Diffing a
     * whole row into an audit entry is the most likely way a credential leaks
     * into a table that is read casually — the repository is responsible for
     * stripping it.
     */
    before: jsonb("before"),
    after: jsonb("after"),

    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),

    /**
     * The actor's email at the time of the action.
     *
     * Denormalised on purpose. This is the one duplication in the schema that
     * 03_DATABASE.md's rule against duplication should not override: an audit
     * entry naming nobody is worthless, and user_id becomes null when the user
     * is deleted.
     */
    actorEmail: text("actor_email"),

    /** Request context, for tracing an action back to a session. */
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /* "What happened to this record?" — the primary audit query. */
    index("audit_logs_entity_idx").on(table.entity, table.entityId, table.createdAt.desc()),

    /* "What did this person do?" */
    index("audit_logs_user_created_idx").on(table.userId, table.createdAt.desc()),

    index("audit_logs_action_idx").on(table.action),
    index("audit_logs_created_at_idx").on(table.createdAt.desc()),
  ],
);

export type AuditLogRow = typeof auditLogs.$inferSelect;
export type NewAuditLogRow = typeof auditLogs.$inferInsert;
