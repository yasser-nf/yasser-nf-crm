-- Authentication history.
--
-- A dedicated table, and the evidence for it is measured rather than assumed:
-- auth.audit_log_entries exists but held 0 rows against 12 refresh tokens, so
-- Supabase is not retaining what this needs. This records what Supabase does
-- not, rather than duplicating what it does.
--
-- Distinct from audit_logs deliberately. Audit is entity-centric ("what happened
-- to this account"); this is identity-centric ("who tried to sign in"). A failed
-- login has no entity to attach to at all.
--
-- NOTE: drizzle-kit also generated
--     ALTER TYPE "public"."user_status" ADD VALUE 'suspended' BEFORE 'disabled';
-- which has been REMOVED. Migration 0004 already added that value by recreating
-- the type, and drizzle's snapshot did not record it because 0004 was authored
-- as a custom migration. Leaving the statement in would fail twice over: the
-- value already exists, and ADD VALUE cannot run inside the transaction
-- drizzle-kit wraps every migration in (SQLSTATE 25001).

CREATE TYPE "public"."auth_event_type" AS ENUM('login_success', 'login_failed', 'logout', 'password_reset_requested', 'password_reset_completed', 'session_expired', 'session_revoked', 'invitation_sent', 'invitation_accepted');--> statement-breakpoint
CREATE TABLE "login_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"email" text,
	"event_type" "auth_event_type" NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_history_user_created_idx" ON "login_history" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "login_history_email_created_idx" ON "login_history" USING btree ("email","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "login_history_event_type_idx" ON "login_history" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "login_history_created_at_idx" ON "login_history" USING btree ("created_at" DESC NULLS LAST);
