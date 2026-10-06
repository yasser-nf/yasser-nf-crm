-- M10 Supplier Manager.
--
-- ADDITIVE ONLY. One new enum label, one new table, one new nullable column on
-- `accounts`, their indexes and their security. No existing row, column,
-- constraint or index is modified, and nothing is backfilled.
--
-- WHY NOTHING IS BACKFILLED
--
-- `accounts.supplier_id` arrives nullable with no default, and NULL means "My
-- Account" — ours. Every account that already exists is therefore correct the
-- moment this runs, and no historical ownership is invented (M10 §8 and §31).
-- Verifying that after deployment is two counts:
--
--   select count(*) from accounts where supplier_id is null;      -- all of them
--   select count(*) from accounts where supplier_id is not null;  -- 0
--
-- WHY THERE IS NO "MY ACCOUNT" SUPPLIER ROW
--
-- A sentinel supplier would be renameable, deactivatable and countable like a
-- real one, and every query would have to remember to exclude it. NULL cannot
-- be edited by mistake. M10 §3.
--
-- WHY ON DELETE RESTRICT
--
-- Deleting a supplier that still owns accounts would either take the accounts
-- with it (absurd) or quietly turn them into ours — a rewrite of history, which
-- M10 §23 forbids. The application offers no delete path at all; it
-- deactivates. This is the database refusing the same thing from any other
-- writer. M10 §24.
--
-- WHY `deactivated_at` AND NOT A STATUS ENUM
--
-- It follows `customers.blocked_at`, whose status is likewise derived. It
-- records when as well as whether, and it adds no two-value enum that
-- PostgreSQL could not later shrink — the rollback hazard recorded in ADR-013
-- and in down/README.md.
--
-- THE ENUM LABEL is the one part of this migration the down file cannot
-- reverse: there is no ALTER TYPE ... DROP VALUE. See
-- down/0016_suppliers.down.sql for why leaving it is the safe answer.
-- PostgreSQL 12+ permits ALTER TYPE ... ADD VALUE inside a transaction block
-- (drizzle runs each migration in one) as long as the new value is not USED in
-- that transaction. Nothing below uses it.
--
-- SECURITY, in the same migration that creates the table, as 0009 and 0014 did:
-- ALTER DEFAULT PRIVILEGES governs grants, not row security, so a table created
-- after 0002 starts with RLS off.
--
-- The policies mirror `accounts_read` / `accounts_write` exactly, because a
-- supplier is account metadata read on the same screens: any active CRM user
-- may read, only a Super Admin may write. A supplier row holds no credential
-- and no financial data (M10 §4), which is what makes the read policy safe to
-- widen to Workers.
--
-- `accounts.supplier_id` needs no policy of its own: RLS is granted per table,
-- not per column, so the new column inherits accounts_read / accounts_write —
-- the same note 0011 made for its three columns.

ALTER TYPE "public"."audit_entity" ADD VALUE 'supplier';--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"notes" text,
	"deactivated_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_name_not_empty" CHECK (length(trim("suppliers"."name")) > 0),
	CONSTRAINT "suppliers_name_normalized_not_empty" CHECK (length("suppliers"."name_normalized") > 0)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_name_normalized_unique" ON "suppliers" USING btree ("name_normalized");--> statement-breakpoint
CREATE INDEX "suppliers_name_idx" ON "suppliers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "suppliers_active_idx" ON "suppliers" USING btree ("deactivated_at");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_supplier_id_idx" ON "accounts" USING btree ("supplier_id") WHERE "accounts"."supplier_id" is not null;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------

REVOKE ALL ON TABLE "suppliers" FROM anon;
--> statement-breakpoint
REVOKE ALL ON TABLE "suppliers" FROM authenticated;
--> statement-breakpoint

ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Any active CRM user may read a supplier: a Worker sees which supplier an
-- account came from (M10 §20), and that is all a supplier row contains.
CREATE POLICY "suppliers_read" ON "suppliers"
  FOR SELECT TO authenticated USING (public.is_crm_user());
--> statement-breakpoint

-- Only a Super Admin may create, rename or deactivate one. Mirrors
-- accounts_write, and mirrors the MANAGE_SUPPLIERS permission the service
-- checks — two independent layers saying the same thing.
CREATE POLICY "suppliers_write" ON "suppliers"
  FOR ALL TO authenticated
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
