-- M08 jobs: the durable job queue and business-operation receipts.
--
-- ADDITIVE, except that audit_entity gains 'job'. No existing table, column,
-- constraint or row changes.
--
--   job_status        queued | running | succeeded | failed | cancelled
--   jobs              the queue: one row per business operation (type +
--                     idempotency_key unique), claimed by one worker at a time
--                     (claim_token), kept alive by heartbeat_at. The check
--                     constraints hold the lifecycle's invariants for any writer.
--   idempotency_keys  receipts: inserted inside a business operation's own
--                     transaction, so a repeat replays instead of re-running.
--
-- audit_entity is RECREATED rather than extended with ALTER TYPE ... ADD VALUE,
-- exactly as 0008 did: drizzle-kit runs every migration in a transaction, and a
-- recreated type is the form this project has already applied to production.
-- Every existing value survives into the new type, so the cast cannot lose data.
--
-- Security, in the same migration that creates the tables (as 0009 and 0014):
-- grants revoked from anon and authenticated, RLS enabled, and NO policy. Jobs
-- and receipts are read and written by the server alone — no role reachable
-- from a browser may read, create, claim, finish or cancel a job.

CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "entity" DROP DEFAULT;
--> statement-breakpoint
ALTER TYPE "public"."audit_entity" RENAME TO "audit_entity_old";
--> statement-breakpoint
CREATE TYPE "public"."audit_entity" AS ENUM('user', 'customer', 'account', 'profile', 'backup', 'settings', 'issue', 'job');
--> statement-breakpoint
ALTER TABLE "audit_logs"
  ALTER COLUMN "entity" TYPE "public"."audit_entity"
  USING ("entity"::text::"public"."audit_entity");
--> statement-breakpoint
DROP TYPE "public"."audit_entity_old";
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"claimed_by" text,
	"claim_token" uuid,
	"last_error" text,
	"last_error_code" text,
	"recovered_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_type_format" CHECK ("jobs"."type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and length("jobs"."type") <= 64),
	CONSTRAINT "jobs_idempotency_key_format" CHECK (length("jobs"."idempotency_key") between 1 and 200),
	CONSTRAINT "jobs_priority_range" CHECK ("jobs"."priority" between -100 and 100),
	CONSTRAINT "jobs_attempts_range" CHECK ("jobs"."max_attempts" between 1 and 20 and "jobs"."attempts" between 0 and "jobs"."max_attempts"),
	CONSTRAINT "jobs_payload_object" CHECK (jsonb_typeof("jobs"."payload") = 'object'),
	CONSTRAINT "jobs_payload_size" CHECK (pg_column_size("jobs"."payload") <= 8192),
	CONSTRAINT "jobs_result_size" CHECK ("jobs"."result" is null or (jsonb_typeof("jobs"."result") = 'object' and pg_column_size("jobs"."result") <= 8192)),
	CONSTRAINT "jobs_claimed_by_length" CHECK ("jobs"."claimed_by" is null or length("jobs"."claimed_by") between 1 and 100),
	CONSTRAINT "jobs_last_error_length" CHECK ("jobs"."last_error" is null or length("jobs"."last_error") <= 500),
	CONSTRAINT "jobs_running_has_owner" CHECK ("jobs"."status" <> 'running' or ("jobs"."claim_token" is not null and "jobs"."claimed_by" is not null and "jobs"."started_at" is not null and "jobs"."heartbeat_at" is not null)),
	CONSTRAINT "jobs_only_running_is_owned" CHECK ("jobs"."status" = 'running' or "jobs"."claim_token" is null),
	CONSTRAINT "jobs_finished_iff_terminal" CHECK (("jobs"."status" in ('succeeded', 'failed', 'cancelled')) = ("jobs"."finished_at" is not null)),
	CONSTRAINT "jobs_cancelled_iff_cancelled_at" CHECK (("jobs"."status" = 'cancelled') = ("jobs"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"actor_id" uuid,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY("scope","key"),
	CONSTRAINT "idempotency_keys_scope_format" CHECK ("idempotency_keys"."scope" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and length("idempotency_keys"."scope") <= 64),
	CONSTRAINT "idempotency_keys_key_length" CHECK (length("idempotency_keys"."key") between 1 and 200),
	CONSTRAINT "idempotency_keys_request_hash_format" CHECK ("idempotency_keys"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_keys_result_size" CHECK ("idempotency_keys"."result" is null or (jsonb_typeof("idempotency_keys"."result") = 'object' and pg_column_size("idempotency_keys"."result") <= 8192))
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_type_idempotency_key_unique" ON "jobs" USING btree ("type","idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("priority" DESC NULLS LAST,"available_at","created_at","id") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_running_heartbeat_idx" ON "jobs" USING btree ("heartbeat_at") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_created_idx" ON "jobs" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "jobs_status_created_idx" ON "jobs" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "jobs_type_created_idx" ON "jobs" USING btree ("type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "jobs_created_by_idx" ON "jobs" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idempotency_keys_actor_idx" ON "idempotency_keys" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");
--> statement-breakpoint

REVOKE ALL ON TABLE "jobs" FROM anon;
--> statement-breakpoint
REVOKE ALL ON TABLE "jobs" FROM authenticated;
--> statement-breakpoint
REVOKE ALL ON TABLE "idempotency_keys" FROM anon;
--> statement-breakpoint
REVOKE ALL ON TABLE "idempotency_keys" FROM authenticated;
--> statement-breakpoint

ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
