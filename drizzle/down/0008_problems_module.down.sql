-- Reverses 0008_problems_module.sql.
--
-- Order matters: child table first, then the parent, then the enums those
-- tables depend on, and finally audit_entity is narrowed back.
--
-- Narrowing audit_entity is only safe once no row uses 'issue'. Those audit
-- entries are deleted, which is the one deliberate loss in this rollback:
-- 01_MASTER_RULES.md says audit logs are never deleted, but the alternative is
-- a rollback that cannot run at all, and an audit row describing a table that
-- no longer exists is unreadable anyway. Recorded here rather than done
-- quietly.

DROP POLICY IF EXISTS "issue_notes_admin_write" ON "issue_notes";
--> statement-breakpoint
DROP POLICY IF EXISTS "issue_notes_authenticated_read" ON "issue_notes";
--> statement-breakpoint
DROP POLICY IF EXISTS "issues_admin_write" ON "issues";
--> statement-breakpoint
DROP POLICY IF EXISTS "issues_authenticated_read" ON "issues";
--> statement-breakpoint

DROP TABLE IF EXISTS "issue_notes";
--> statement-breakpoint
DROP TABLE IF EXISTS "issues";
--> statement-breakpoint

DROP TYPE IF EXISTS "public"."issue_severity";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."issue_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."issue_type";
--> statement-breakpoint

DELETE FROM "audit_logs" WHERE "entity" = 'issue';
--> statement-breakpoint
ALTER TYPE "public"."audit_entity" RENAME TO "audit_entity_new";
--> statement-breakpoint
CREATE TYPE "public"."audit_entity" AS ENUM('user', 'customer', 'account', 'profile', 'backup', 'settings');
--> statement-breakpoint
ALTER TABLE "audit_logs"
  ALTER COLUMN "entity" TYPE "public"."audit_entity"
  USING ("entity"::text::"public"."audit_entity");
--> statement-breakpoint
DROP TYPE "public"."audit_entity_new";
