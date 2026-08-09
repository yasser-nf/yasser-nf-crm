-- Rollback of 0004_user_status_suspended.sql
--
-- PostgreSQL cannot remove a value from an enum. Reversing this means
-- recreating the type without `suspended`, which requires every dependent
-- column to be rewritten.
--
-- Any user currently suspended must be moved to another status FIRST, or the
-- cast below fails.

ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TYPE "public"."user_status" RENAME TO "user_status_old";
--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "status" TYPE "public"."user_status"
  USING ("status"::text::"public"."user_status");
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'active';
--> statement-breakpoint
DROP TYPE "public"."user_status_old";
