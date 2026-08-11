-- Reverses 0009_report_presets.sql.
--
-- Dropping the table takes its policy, indexes and constraints with it. Saved
-- presets are lost, which is acceptable and worth stating: a preset is a saved
-- view, not business data, and it can be recreated in seconds. Nothing else in
-- the system references this table.

DROP POLICY IF EXISTS "report_presets_own_rows" ON "report_presets";
--> statement-breakpoint
DROP TABLE IF EXISTS "report_presets";
