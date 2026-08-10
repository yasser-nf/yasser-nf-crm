-- M07 Backup & Restore.
--
-- Two changes: the backup_type enum gains three values, and `backups` gains the
-- metadata the Backup Details screen needs.
--
-- The enum is RECREATED rather than extended with ALTER TYPE ... ADD VALUE.
-- ADD VALUE cannot run inside a transaction block and drizzle-kit wraps every
-- migration in one, so that form fails with SQLSTATE 25001. Recreating is
-- transaction-safe. Every existing value ('hourly', 'daily', 'manual') survives
-- into the new type, so the cast cannot lose data.
--
-- `weekly` and `monthly` come from the M07 brief. `hourly` is kept because
-- 01_MASTER_RULES.md, ADR-001, 02_ARCHITECTURE.md and 03_DATABASE.md all require
-- it — see ADR-009 Decision 3. `snapshot` is the System Snapshot type.

ALTER TYPE "public"."backup_type" RENAME TO "backup_type_old";
--> statement-breakpoint
CREATE TYPE "public"."backup_type" AS ENUM('hourly', 'daily', 'weekly', 'monthly', 'manual', 'snapshot');
--> statement-breakpoint
ALTER TABLE "backups"
  ALTER COLUMN "type" TYPE "public"."backup_type"
  USING ("type"::text::"public"."backup_type");
--> statement-breakpoint
DROP TYPE "public"."backup_type_old";
--> statement-breakpoint

-- Existing rows need a name. There are none in practice, but a NOT NULL column
-- added to a populated table without a default would fail, and a migration that
-- only works on an empty table is a migration that fails in production.
ALTER TABLE "backups" ADD COLUMN "name" text NOT NULL DEFAULT 'Untitled backup';
--> statement-breakpoint
ALTER TABLE "backups" ALTER COLUMN "name" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "format_version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "app_version" text;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "database_version" text;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "table_counts" jsonb NOT NULL DEFAULT '{}'::jsonb;
