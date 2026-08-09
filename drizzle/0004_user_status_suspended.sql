-- Adds `suspended` to user_status.
--
-- M06 defines three distinct states. `active` and `disabled` already existed;
-- `suspended` is new.
--
--   suspended  cannot authenticate, sessions left intact
--   disabled   cannot authenticate, sessions revoked immediately
--
-- The type is RECREATED rather than extended with ALTER TYPE ... ADD VALUE.
-- ADD VALUE cannot run inside a transaction block, and drizzle-kit wraps every
-- migration in one, so that form fails with SQLSTATE 25001. Recreating is
-- transaction-safe and also lets the values be ordered by severity rather than
-- by the order they happened to be added.
--
-- Safe for existing rows: every current value ('active', 'disabled') exists in
-- the new type, so the cast below cannot lose data.

ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TYPE "public"."user_status" RENAME TO "user_status_old";
--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'disabled');
--> statement-breakpoint
ALTER TABLE "users"
  ALTER COLUMN "status" TYPE "public"."user_status"
  USING ("status"::text::"public"."user_status");
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'active';
--> statement-breakpoint
DROP TYPE "public"."user_status_old";
