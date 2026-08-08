import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { userRoleEnum, userStatusEnum } from "./enums";

/**
 * CRM users.
 *
 * ADR-005 Decision 3: `id` holds the same value as auth.users(id), and the
 * foreign key is added by hand-written SQL in the migration. Declaring it here
 * would make drizzle-kit try to manage the auth schema, which belongs to
 * Supabase.
 *
 * There is no password column of any kind. Supabase Auth owns credentials, so a
 * second store would contradict ADR-001 and duplicate data 03_DATABASE.md
 * forbids duplicating. Sharing the primary key means one identity with nothing
 * to synchronise.
 *
 * This table is the authoritative location for `role`, resolving the deferral
 * recorded in ADR-003.
 */
export const users = pgTable(
  "users",
  {
    /** Same value as auth.users.id. Deliberately not generated here. */
    id: uuid("id").primaryKey(),

    name: text("name").notNull(),
    email: text("email").notNull(),

    role: userRoleEnum("role").notNull().default("worker"),
    status: userStatusEnum("status").notNull().default("active"),

    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * Soft delete. A user referenced by an immutable audit log cannot be hard
     * deleted without either destroying history or breaking the reference.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    /*
     * Unique among live rows only. A plain unique index would block re-adding a
     * colleague who previously left, because their soft-deleted row would still
     * hold the address.
     */
    uniqueIndex("users_email_unique_live")
      .on(table.email)
      .where(sql`${table.deletedAt} is null`),

    index("users_role_idx").on(table.role),
    index("users_status_idx").on(table.status),
    index("users_created_at_idx").on(table.createdAt),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
