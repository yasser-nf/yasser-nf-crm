-- M09B Suppliers: where an account came from.
--
-- ADDITIVE. No existing table is dropped, no existing column changes type, and
-- every existing row keeps every value it had.
--
--   account_ownership  owned | supplied | unknown
--   suppliers          the outside parties some accounts are obtained from
--   accounts.ownership      where this account came from
--   accounts.supplier_id    which supplier, when it came from one
--
-- CLASSIFYING THE ACCOUNTS THAT PREDATE THIS COLUMN
--
-- drizzle-kit's own form for a new NOT NULL column is a DEFAULT, which would
-- have made every existing account `unknown`. They are not unknown: they are
-- the business's own accounts, confirmed by the operator who owns them, so
-- they are classified by an explicit UPDATE that is visible in this file and
-- asserted by tests. The default is then set to `unknown` for rows written
-- afterwards, so a future insert that forgets to say cannot silently claim
-- ownership of somebody else's account.
--
-- The UPDATE touches `ownership` and nothing else; no account's email,
-- password, status, dates or profiles are read or written.
--
-- A supplier is never deleted out from under the accounts naming it:
-- supplier_id is ON DELETE RESTRICT, and only a `supplied` account may carry
-- one (accounts_supplier_requires_supplied).

CREATE TYPE "public"."account_ownership" AS ENUM('owned', 'supplied', 'unknown');--> statement-breakpoint


CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "suppliers_name_not_empty" CHECK (length(btrim("suppliers"."name")) between 1 and 120),
	CONSTRAINT "suppliers_contact_length" CHECK ("suppliers"."contact" is null or length("suppliers"."contact") <= 200)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "ownership" "account_ownership";
--> statement-breakpoint

-- Every account that exists when this runs is the business's own.
UPDATE "accounts" SET "ownership" = 'owned' WHERE "ownership" IS NULL;
--> statement-breakpoint

ALTER TABLE "accounts" ALTER COLUMN "ownership" SET DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "ownership" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_name_unique_live" ON "suppliers" USING btree (lower(btrim("name"))) WHERE "suppliers"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "suppliers_name_idx" ON "suppliers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "suppliers_created_by_idx" ON "suppliers" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_ownership_idx" ON "accounts" USING btree ("ownership");--> statement-breakpoint
CREATE INDEX "accounts_supplier_idx" ON "accounts" USING btree ("supplier_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_supplier_requires_supplied" CHECK ("accounts"."supplier_id" is null or "accounts"."ownership" = 'supplied');
--> statement-breakpoint

-- Security, in the migration that creates the table (as 0009 and 0014 did).
-- Suppliers mirror accounts: every signed-in CRM user may read the live rows,
-- and only a Super Admin may write one. The service checks the permission as
-- well; this is the floor underneath it.

ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "suppliers_read" ON "suppliers"
  FOR SELECT TO authenticated USING (public.is_crm_user() AND deleted_at IS NULL);
--> statement-breakpoint
CREATE POLICY "suppliers_write" ON "suppliers"
  FOR ALL TO authenticated
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
