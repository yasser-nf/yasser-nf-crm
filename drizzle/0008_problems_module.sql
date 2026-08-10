-- M08 Problems module.
--
-- Creates the `issues` table that 03_DATABASE.md specifies and ADR-005
-- Decision 1 deferred, plus `issue_notes` for append-only internal notes.
--
-- Three new enums, and one existing enum extended: audit_entity gains 'issue',
-- because the problem timeline is read from audit_logs rather than from a
-- second history table (ADR-010 Decision 3).
--
-- audit_entity is RECREATED rather than extended with ALTER TYPE ... ADD VALUE.
-- ADD VALUE cannot run inside a transaction block and drizzle-kit wraps every
-- migration in one, so that form fails with SQLSTATE 25001. Every existing
-- value survives into the new type, so the cast cannot lose data.
--
-- Both new tables receive the same two-layer security model as every other
-- table: REVOKE the grants, ENABLE RLS, then an explicit policy.

CREATE TYPE "public"."issue_type" AS ENUM('payment_problem', 'incorrect_password', 'invalid_email', 'something_went_wrong', 'other');
--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('open', 'in_progress', 'waiting', 'resolved', 'closed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."issue_severity" AS ENUM('low', 'medium', 'high', 'critical');
--> statement-breakpoint

ALTER TABLE "audit_logs" ALTER COLUMN "entity" DROP DEFAULT;
--> statement-breakpoint
ALTER TYPE "public"."audit_entity" RENAME TO "audit_entity_old";
--> statement-breakpoint
CREATE TYPE "public"."audit_entity" AS ENUM('user', 'customer', 'account', 'profile', 'backup', 'settings', 'issue');
--> statement-breakpoint
ALTER TABLE "audit_logs"
  ALTER COLUMN "entity" TYPE "public"."audit_entity"
  USING ("entity"::text::"public"."audit_entity");
--> statement-breakpoint
DROP TYPE "public"."audit_entity_old";
--> statement-breakpoint

CREATE TABLE "issues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "issue_type" "issue_type" NOT NULL,
  "status" "issue_status" DEFAULT 'open' NOT NULL,
  "severity" "issue_severity" DEFAULT 'medium' NOT NULL,
  "description" text NOT NULL,
  "assigned_to" uuid,
  "reported_by" uuid,
  "resolved_by" uuid,
  "resolution_note" text,
  "reopen_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  CONSTRAINT "issues_resolved_has_note" CHECK ("status" <> 'resolved' OR ("resolution_note" IS NOT NULL AND "resolved_at" IS NOT NULL AND "resolved_by" IS NOT NULL)),
  CONSTRAINT "issues_reopen_count_non_negative" CHECK ("reopen_count" >= 0)
);
--> statement-breakpoint

CREATE TABLE "issue_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "issue_id" uuid NOT NULL,
  "user_id" uuid,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "issue_notes_body_not_empty" CHECK (length(trim("body")) > 0)
);
--> statement-breakpoint

ALTER TABLE "issues" ADD CONSTRAINT "issues_account_id_accounts_id_fk"
  FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assigned_to_users_id_fk"
  FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_reported_by_users_id_fk"
  FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_resolved_by_users_id_fk"
  FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_notes" ADD CONSTRAINT "issue_notes_issue_id_issues_id_fk"
  FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_notes" ADD CONSTRAINT "issue_notes_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "issues_account_idx" ON "issues" USING btree ("account_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "issues_status_idx" ON "issues" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "issues_severity_idx" ON "issues" USING btree ("severity");
--> statement-breakpoint
CREATE INDEX "issues_assigned_idx" ON "issues" USING btree ("assigned_to");
--> statement-breakpoint
CREATE INDEX "issues_type_idx" ON "issues" USING btree ("issue_type");
--> statement-breakpoint
CREATE INDEX "issues_created_at_idx" ON "issues" USING btree ("created_at" DESC);
--> statement-breakpoint

-- The allocation hot path. Partial, so it stays small as resolved problems
-- accumulate: only rows that can actually block an account are indexed.
CREATE INDEX "issues_active_by_account_idx" ON "issues" USING btree ("account_id")
  WHERE "status" IN ('open', 'in_progress', 'waiting');
--> statement-breakpoint

CREATE INDEX "issue_notes_issue_idx" ON "issue_notes" USING btree ("issue_id","created_at" DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Two-layer security, identical to migration 0002
-- ---------------------------------------------------------------------------
-- ALTER DEFAULT PRIVILEGES governs grants, not row security, so a table created
-- after 0002 starts with RLS OFF. That is exactly how login_history shipped
-- unprotected in M06 and needed migration 0006 to fix. Both layers are applied
-- here, in the same migration that creates the tables.

REVOKE ALL ON TABLE "issues" FROM anon;
--> statement-breakpoint
REVOKE ALL ON TABLE "issues" FROM authenticated;
--> statement-breakpoint
REVOKE ALL ON TABLE "issue_notes" FROM anon;
--> statement-breakpoint
REVOKE ALL ON TABLE "issue_notes" FROM authenticated;
--> statement-breakpoint

ALTER TABLE "issues" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "issue_notes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Visibility is global for signed-in staff and mutability is ownership-based,
-- but ownership is a business rule the service owns, not a row filter. These
-- policies are the outer wall: only authenticated staff, never anon.
CREATE POLICY "issues_authenticated_read" ON "issues"
  FOR SELECT TO authenticated
  USING (public.current_app_role() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY "issues_admin_write" ON "issues"
  FOR ALL TO authenticated
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
--> statement-breakpoint
CREATE POLICY "issue_notes_authenticated_read" ON "issue_notes"
  FOR SELECT TO authenticated
  USING (public.current_app_role() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY "issue_notes_admin_write" ON "issue_notes"
  FOR ALL TO authenticated
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
