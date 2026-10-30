-- Reverses 0016_suppliers.sql.
--
-- Drops the supplier relationship, then the table, then the enum. What is
-- lost, stated rather than done quietly:
--
--   accounts.ownership    which accounts were the business's own and which
--                         came from a supplier
--   accounts.supplier_id  which supplier each supplied account came from
--   suppliers             every supplier record
--
-- None of it is recoverable from the remaining columns, so take a backup
-- first if the classification matters. No account, profile or customer row is
-- deleted — only these two columns are removed from `accounts`.

ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "accounts_supplier_requires_supplied";
--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "accounts_supplier_id_suppliers_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "accounts_supplier_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "accounts_ownership_idx";
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN IF EXISTS "supplier_id";
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN IF EXISTS "ownership";
--> statement-breakpoint

DROP POLICY IF EXISTS "suppliers_write" ON "suppliers";
--> statement-breakpoint
DROP POLICY IF EXISTS "suppliers_read" ON "suppliers";
--> statement-breakpoint
DROP TABLE IF EXISTS "suppliers";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."account_ownership";
