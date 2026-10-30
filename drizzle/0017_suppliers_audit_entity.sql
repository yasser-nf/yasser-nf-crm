-- M09B: audit_entity gains 'supplier'.
--
-- RECREATED rather than ALTER TYPE ... ADD VALUE, which is what drizzle-kit
-- generates and what 0008 and 0015 both replaced for the same reason: ADD
-- VALUE cannot run inside a transaction block and drizzle-kit wraps every
-- migration in one, so that form fails with SQLSTATE 25001.
--
-- Every existing value survives into the new type, so the cast cannot lose
-- data. The table is rewritten under a brief ACCESS EXCLUSIVE lock.

ALTER TABLE "audit_logs" ALTER COLUMN "entity" DROP DEFAULT;
--> statement-breakpoint
ALTER TYPE "public"."audit_entity" RENAME TO "audit_entity_old";
--> statement-breakpoint
CREATE TYPE "public"."audit_entity" AS ENUM('user', 'customer', 'account', 'profile', 'backup', 'settings', 'issue', 'job', 'supplier');
--> statement-breakpoint
ALTER TABLE "audit_logs"
  ALTER COLUMN "entity" TYPE "public"."audit_entity"
  USING ("entity"::text::"public"."audit_entity");
--> statement-breakpoint
DROP TYPE "public"."audit_entity_old";
