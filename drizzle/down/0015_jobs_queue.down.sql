-- Reverses 0015_jobs_queue.sql.
--
-- Drops the two tables (their indexes, constraints and RLS go with them), the
-- job_status enum, and narrows audit_entity back.
--
-- What is lost, stated rather than done quietly:
--   jobs              the queue and its history. Run it only with no job
--                     queued or running — a running job's worker would find
--                     its row gone.
--   idempotency_keys  the receipts. After this, a repeat of an operation that
--                     already committed is no longer recognised; the code that
--                     reads them must be rolled back first.
--   audit_logs        entries with entity 'job' are deleted, as 0008's rollback
--                     deleted 'issue' entries: the narrowed type cannot hold
--                     them, and they describe a table that no longer exists.

DROP TABLE IF EXISTS "idempotency_keys";
--> statement-breakpoint
DROP TABLE IF EXISTS "jobs";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."job_status";
--> statement-breakpoint

DELETE FROM "audit_logs" WHERE "entity" = 'job';
--> statement-breakpoint
ALTER TYPE "public"."audit_entity" RENAME TO "audit_entity_new";
--> statement-breakpoint
CREATE TYPE "public"."audit_entity" AS ENUM('user', 'customer', 'account', 'profile', 'backup', 'settings', 'issue');
--> statement-breakpoint
ALTER TABLE "audit_logs"
  ALTER COLUMN "entity" TYPE "public"."audit_entity"
  USING ("entity"::text::"public"."audit_entity");
--> statement-breakpoint
DROP TYPE "public"."audit_entity_new";
