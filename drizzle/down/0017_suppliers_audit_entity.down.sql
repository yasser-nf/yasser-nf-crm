-- Reverses 0017_suppliers_audit_entity.sql.
--
-- Narrowing audit_entity is only safe once no row uses 'supplier'. Those audit
-- entries are deleted, as 0008's and 0015's rollbacks delete theirs: the
-- narrowed type cannot hold them, and they describe a table that the companion
-- rollback (0016) removes anyway.

DELETE FROM "audit_logs" WHERE "entity" = 'supplier';
--> statement-breakpoint
ALTER TYPE "public"."audit_entity" RENAME TO "audit_entity_new";
--> statement-breakpoint
CREATE TYPE "public"."audit_entity" AS ENUM('user', 'customer', 'account', 'profile', 'backup', 'settings', 'issue', 'job');
--> statement-breakpoint
ALTER TABLE "audit_logs"
  ALTER COLUMN "entity" TYPE "public"."audit_entity"
  USING ("entity"::text::"public"."audit_entity");
--> statement-breakpoint
DROP TYPE "public"."audit_entity_new";
