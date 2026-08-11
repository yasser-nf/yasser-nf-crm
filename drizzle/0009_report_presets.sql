-- M10 Reports & Export.
--
-- One table, and the M10 brief asks for the justification: a preset is a
-- per-user row that accumulates. `settings` was the alternative and is a
-- singleton by construction, so every user's presets would share one JSON blob
-- with no ownership and concurrent saves would clobber each other. See ADR-011
-- Decision 2.
--
-- Two-layer security applied in the same migration that creates the table —
-- ALTER DEFAULT PRIVILEGES governs grants, not row security, so a table created
-- after 0002 starts with RLS off. That is how login_history shipped unprotected
-- in M06 and needed a follow-up migration.
--
-- The policy here is narrower than any previous table: a preset belongs to one
-- person, so the row filter is ownership rather than role. Even a Super Admin
-- has no business reading somebody else's saved views through the API.

CREATE TABLE "report_presets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "report" text NOT NULL,
  "name" text NOT NULL,
  "filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "sort" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "export_format" text DEFAULT 'csv' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "report_presets_name_not_empty" CHECK (length(trim("name")) > 0),
  CONSTRAINT "report_presets_format_known" CHECK ("export_format" IN ('csv', 'excel', 'pdf'))
);
--> statement-breakpoint

ALTER TABLE "report_presets" ADD CONSTRAINT "report_presets_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "report_presets_user_idx" ON "report_presets" USING btree ("user_id","report");
--> statement-breakpoint
CREATE UNIQUE INDEX "report_presets_unique_name" ON "report_presets" USING btree ("user_id","report","name");
--> statement-breakpoint

REVOKE ALL ON TABLE "report_presets" FROM anon;
--> statement-breakpoint
REVOKE ALL ON TABLE "report_presets" FROM authenticated;
--> statement-breakpoint

ALTER TABLE "report_presets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "report_presets_own_rows" ON "report_presets"
  FOR ALL TO authenticated
  USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());
