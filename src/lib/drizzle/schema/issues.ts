import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { accounts } from "./accounts";
import { issueSeverityEnum, issueStatusEnum, issueTypeEnum } from "./enums";
import { users } from "./users";

/**
 * Problems.
 *
 * The table 03_DATABASE.md calls `issues` and ADR-005 Decision 1 deferred. The
 * name is kept as documented; the UI says "problem", which is the word the
 * business uses. One concept, two vocabularies — renaming a LOCKED table to
 * match a screen label would be the wrong trade.
 *
 * Account grain, per 03_DATABASE.md: "Issues belong to Accounts. Never
 * Profiles." Affected profiles are derived rather than stored — an unhealthy
 * account makes all five unavailable, which is already the documented rule. See
 * ADR-010 Decision 2.
 *
 * This table stores current state only. Its history lives in `audit_logs`, and
 * its notes in `issue_notes`; neither is duplicated here.
 */
export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),

    issueType: issueTypeEnum("issue_type").notNull(),
    status: issueStatusEnum("status").notNull().default("open"),
    severity: issueSeverityEnum("severity").notNull().default("medium"),

    description: text("description").notNull(),

    /**
     * Who is working on it. Null when unassigned.
     *
     * `set null` rather than cascade: losing the worker must never delete the
     * record of the problem itself.
     */
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),

    reportedBy: uuid("reported_by").references(() => users.id, { onDelete: "set null" }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),

    /** Required to reach `resolved`. Enforced by the check constraint below. */
    resolutionNote: text("resolution_note"),

    /**
     * How many times this problem came back.
     *
     * A recurring fault is a different signal from a one-off, and it is only
     * visible if reopening is counted rather than just re-dated.
     */
    reopenCount: integer("reopen_count").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    /* The list is filtered by these, and the account screen reads by account. */
    index("issues_account_idx").on(table.accountId, table.createdAt.desc()),
    index("issues_status_idx").on(table.status),
    index("issues_severity_idx").on(table.severity),
    index("issues_assigned_idx").on(table.assignedTo),
    index("issues_type_idx").on(table.issueType),
    index("issues_created_at_idx").on(table.createdAt.desc()),

    /*
     * The allocation hot path: "does this account have an active blocking
     * problem". Partial, so it indexes only the rows that can block — the set
     * that stays small even as resolved problems accumulate forever.
     */
    index("issues_active_by_account_idx")
      .on(table.accountId)
      .where(sql`${table.status} in ('open', 'in_progress', 'waiting')`),

    /*
     * A resolved problem must say how it was resolved. Without this, "resolved"
     * becomes a status somebody set, not an account of what was done — and the
     * next person to hit the same fault learns nothing.
     */
    check(
      "issues_resolved_has_note",
      sql`${table.status} <> 'resolved'
          or (${table.resolutionNote} is not null and ${table.resolvedAt} is not null and ${table.resolvedBy} is not null)`,
    ),

    check("issues_reopen_count_non_negative", sql`${table.reopenCount} >= 0`),
  ],
);

/**
 * Internal notes on a problem.
 *
 * Append-only: no update path exists anywhere in the codebase, and there is no
 * `updated_at` because a note that can change is not a record of what someone
 * said at the time.
 *
 * A separate table rather than audit entries, because a note is not a change to
 * an entity — it has an author and a body, and nothing before or after.
 */
export const issueNotes = pgTable(
  "issue_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),

    /** Null once the author is deleted. The note survives them. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),

    body: text("body").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("issue_notes_issue_idx").on(table.issueId, table.createdAt.desc()),
    check("issue_notes_body_not_empty", sql`length(trim(${table.body})) > 0`),
  ],
);

export type IssueRow = typeof issues.$inferSelect;
export type NewIssueRow = typeof issues.$inferInsert;
export type IssueNoteRow = typeof issueNotes.$inferSelect;
export type NewIssueNoteRow = typeof issueNotes.$inferInsert;
