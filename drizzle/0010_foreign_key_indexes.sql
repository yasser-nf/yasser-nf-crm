-- M12 Part 7: index the five unindexed foreign keys.
--
-- PostgreSQL indexes the referenced side of a foreign key automatically and the
-- referencing side never. Without an index on the child column, deleting or
-- updating a parent row scans the whole child table and holds a lock for the
-- duration.
--
-- Measured, not assumed: the M12 audit found exactly these five.
--
--   backups.created_by      → users
--   issue_notes.user_id     → users
--   issues.reported_by      → users
--   issues.resolved_by      → users
--   settings.updated_by     → users
--
-- Every one points at `users`, which is the table whose deletes matter most:
-- removing a user currently scans four tables and takes locks on all of them.
-- At today's row counts that is microseconds; the point of fixing it now is
-- that it stops being microseconds silently.
--
-- `issues.assigned_to` already has an index (issues_assigned_idx) and is
-- deliberately absent from this list.

CREATE INDEX IF NOT EXISTS "backups_created_by_idx" ON "backups" USING btree ("created_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_notes_user_idx" ON "issue_notes" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_reported_by_idx" ON "issues" USING btree ("reported_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_resolved_by_idx" ON "issues" USING btree ("resolved_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "settings_updated_by_idx" ON "settings" USING btree ("updated_by");
