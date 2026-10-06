-- Reverses 0016_suppliers.sql.
--
-- DESTRUCTIVE in one respect worth stating plainly: dropping
-- `accounts.supplier_id` discards which supplier every account came from, and
-- nothing else stores it. Every account silently becomes "My Account" again.
-- The supplier rows themselves go with the table.
--
-- Order matters. The foreign key must go before the table it points at, and the
-- column before the table, or the DROP TABLE is refused.
--
-- WHAT THIS CANNOT REVERSE
--
-- The `'supplier'` label added to the `audit_entity` enum. PostgreSQL has no
-- ALTER TYPE ... DROP VALUE, and the only way to remove one is to rebuild the
-- type — which failed in M13 Phase B while a CHECK constraint and a partial
-- index still bound literals of the old type (see down/README.md and ADR-013
-- Decision 2). That incident is why this migration adds a value and no more.
--
-- Leaving the label is harmless. Once the table and the column are gone no new
-- row can carry it, and any audit entry that already does is history, which
-- 01_MASTER_RULES.md forbids deleting. An orphan enum label costs nothing;
-- rebuilding a type that `audit_logs.entity` depends on risks the audit trail.

DROP POLICY IF EXISTS "suppliers_write" ON "suppliers";
--> statement-breakpoint
DROP POLICY IF EXISTS "suppliers_read" ON "suppliers";
--> statement-breakpoint
DROP INDEX IF EXISTS "accounts_supplier_id_idx";
--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "accounts_supplier_id_suppliers_id_fk";
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN IF EXISTS "supplier_id";
--> statement-breakpoint
DROP TABLE IF EXISTS "suppliers";
