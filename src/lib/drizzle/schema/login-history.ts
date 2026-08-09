import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { authEventTypeEnum } from "./enums";
import { users } from "./users";

/**
 * Authentication history.
 *
 * A dedicated table, and the M06 continuation brief is explicit about why:
 * auth.audit_log_entries exists but was measured empty — 0 rows against 12
 * refresh tokens — so it cannot be the source. This is not duplicating Supabase
 * data; it is recording what Supabase does not retain.
 *
 * Distinct from audit_logs on purpose. Audit is entity-centric ("what happened
 * to this account"); this is identity-centric ("who tried to sign in"). Merging
 * them would make an audit trail of business changes unreadable, and a failed
 * login has no entity to attach to.
 *
 * Append-only: no updated_at, no deleted_at. A security log that can be edited
 * is not a security log.
 */
export const loginHistory = pgTable(
  "login_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Null when the attempt could not be resolved to a user.
     *
     * A failed login against an address that does not exist still has to be
     * recorded — that pattern IS the signal worth seeing — and there is no user
     * to reference. SET NULL on delete for the same reason audit_logs uses it:
     * removing a person must not erase the record of their sign-ins.
     */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),

    /**
     * The address the attempt used, stored as typed.
     *
     * Denormalised deliberately. It is the only identifying detail a failed
     * attempt against an unknown address carries, and it must survive the user
     * being deleted.
     */
    email: text("email"),

    eventType: authEventTypeEnum("event_type").notNull(),

    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),

    /** Why a failure failed. Never contains a password or a token. */
    failureReason: text("failure_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /* "Show me this person's sign-ins, newest first" — the primary read. */
    index("login_history_user_created_idx").on(table.userId, table.createdAt.desc()),

    /*
     * Failed attempts by address. This is the index that makes a brute-force
     * pattern visible without scanning the whole table.
     */
    index("login_history_email_created_idx").on(table.email, table.createdAt.desc()),

    index("login_history_event_type_idx").on(table.eventType),
    index("login_history_created_at_idx").on(table.createdAt.desc()),
  ],
);

export type LoginHistoryRow = typeof loginHistory.$inferSelect;
export type NewLoginHistoryRow = typeof loginHistory.$inferInsert;
