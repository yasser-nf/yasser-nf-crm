-- Reverses 0010_foreign_key_indexes.sql.
--
-- Dropping an index is always safe: it removes a performance property, never
-- data and never a constraint. The foreign keys themselves are untouched.

DROP INDEX IF EXISTS "settings_updated_by_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "issues_resolved_by_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "issues_reported_by_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "issue_notes_user_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "backups_created_by_idx";
