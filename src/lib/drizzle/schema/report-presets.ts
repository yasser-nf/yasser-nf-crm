import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { users } from "./users";

/**
 * Saved report presets.
 *
 * The only schema M10 adds, and the M10 brief asks for the justification:
 *
 * A preset is a per-user row that accumulates — one person may keep a dozen.
 * `settings` was the alternative and is a singleton by construction (a unique
 * index on `singleton`), so every user's presets would share one JSON blob with
 * no ownership and no way to enforce it; two people saving at once would clobber
 * each other. Rows with an owner are what a table is for.
 *
 * Recorded in ADR-011 Decision 2.
 */
export const reportPresets = pgTable(
  "report_presets",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Owner. Presets die with the account, unlike a backup or an audit entry. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** Which report this preset configures. Matches a key in report-definitions. */
    report: text("report").notNull(),
    name: text("name").notNull(),

    /**
     * The saved view: filters, visible columns, sort and export format.
     *
     * jsonb rather than typed columns because the shape differs per report — a
     * problems filter has severity, a backups filter has type — and a column per
     * possible filter would be mostly null and would need a migration every time
     * a report gains one. Validated by Zod at the boundary.
     */
    filters: jsonb("filters").notNull().default({}),
    columns: jsonb("columns").notNull().default([]),
    sort: jsonb("sort").notNull().default({}),
    exportFormat: text("export_format").notNull().default("csv"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("report_presets_user_idx").on(table.userId, table.report),

    /* One name per report per person, so "Save" can update rather than duplicate. */
    uniqueIndex("report_presets_unique_name").on(table.userId, table.report, table.name),

    check("report_presets_name_not_empty", sql`length(trim(${table.name})) > 0`),
    check(
      "report_presets_format_known",
      sql`${table.exportFormat} in ('csv', 'excel', 'pdf')`,
    ),
  ],
);

export type ReportPresetRow = typeof reportPresets.$inferSelect;
export type NewReportPresetRow = typeof reportPresets.$inferInsert;
