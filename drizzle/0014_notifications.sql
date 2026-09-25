-- M05 Notifications.
--
-- The table ADR-005 Decision 1 deferred: one row per message to one person.
-- ADDITIVE ONLY — a new table, its foreign keys and indexes, and its security.
-- No existing table, column, constraint or row is touched.
--
--   recipient_id   who it is for; cascades with the user row
--   actor_id       who caused it; kept (set null) when they leave
--   type           a closed set, checked below
--   title / body   a snapshot of what happened; never credentials
--   entity_*       what to open, resolved to a route by the service
--   dedupe_key     one event, one notification per recipient (unique index)
--   read_at        null while unread
--
-- Two-layer security in the same migration that creates the table, as 0009
-- did for report_presets: ALTER DEFAULT PRIVILEGES governs grants, not row
-- security, so a table created after 0002 starts with RLS off.
--
-- The policy is narrower than report_presets': SELECT only, own rows only.
-- Notifications are written by the server alone, so no role reachable from a
-- browser may insert, update or delete one — even for itself.

CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" uuid NOT NULL,
	"actor_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"entity_type" text,
	"entity_id" uuid,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_type_known" CHECK ("notifications"."type" in ('problem_reported', 'problem_assigned', 'problem_resolved', 'problem_reopened')),
	CONSTRAINT "notifications_title_not_empty" CHECK (length(trim("notifications"."title")) > 0),
	CONSTRAINT "notifications_entity_complete" CHECK (("notifications"."entity_type" is null) = ("notifications"."entity_id" is null))
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "notifications" USING btree ("recipient_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("recipient_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_entity_idx" ON "notifications" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_recipient_dedupe_unique" ON "notifications" USING btree ("recipient_id","dedupe_key");

--> statement-breakpoint

REVOKE ALL ON TABLE "notifications" FROM anon;
--> statement-breakpoint
REVOKE ALL ON TABLE "notifications" FROM authenticated;
--> statement-breakpoint

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "notifications_own_rows_select" ON "notifications"
  FOR SELECT TO authenticated
  USING ("recipient_id" = auth.uid());
