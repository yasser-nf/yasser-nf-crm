-- Reverses 0007_backup_module.sql.
--
-- Order matters: the added columns are dropped first, then the enum is narrowed.
--
-- Narrowing the enum is only safe if no row still uses a removed value. Rows of
-- type 'weekly', 'monthly' or 'snapshot' are mapped to 'manual' before the cast,
-- because the alternative is a migration that fails halfway. The mapping is
-- lossy and deliberately so — reverting a feature that introduced new kinds of
-- backup cannot preserve a distinction the old type could not express.

ALTER TABLE "backups" DROP COLUMN IF EXISTS "table_counts";
--> statement-breakpoint
ALTER TABLE "backups" DROP COLUMN IF EXISTS "database_version";
--> statement-breakpoint
ALTER TABLE "backups" DROP COLUMN IF EXISTS "app_version";
--> statement-breakpoint
ALTER TABLE "backups" DROP COLUMN IF EXISTS "format_version";
--> statement-breakpoint
ALTER TABLE "backups" DROP COLUMN IF EXISTS "name";
--> statement-breakpoint

UPDATE "backups" SET "type" = 'manual'
  WHERE "type" IN ('weekly', 'monthly', 'snapshot');
--> statement-breakpoint
ALTER TYPE "public"."backup_type" RENAME TO "backup_type_new";
--> statement-breakpoint
CREATE TYPE "public"."backup_type" AS ENUM('hourly', 'daily', 'manual');
--> statement-breakpoint
ALTER TABLE "backups"
  ALTER COLUMN "type" TYPE "public"."backup_type"
  USING ("type"::text::"public"."backup_type");
--> statement-breakpoint
DROP TYPE "public"."backup_type_new";
