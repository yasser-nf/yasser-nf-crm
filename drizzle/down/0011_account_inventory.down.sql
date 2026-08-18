-- Reverses 0011_account_inventory.sql.
--
-- DESTRUCTIVE. Dropping valid_from, valid_until and profile_slots discards the
-- inventory metadata for every account, and nothing else stores it. Every
-- account silently returns to "sells five profiles, open-ended coverage".
--
-- Nothing else has to be undone. This migration adds no enum label, no trigger
-- and no table, and it changes no existing constraint — which is exactly why it
-- is reversible in six plain statements.
--
-- The earlier two-migration draft was NOT: it added a `not_for_sale` enum label,
-- and PostgreSQL has no ALTER TYPE ... DROP VALUE, so reversing it meant
-- rebuilding the type. That rebuild failed the first time it was run, because
-- ALTER COLUMN ... TYPE cannot proceed while a CHECK constraint and a partial
-- index still bind typed literals of the old type. See ADR-013 Decision 2 and
-- the note in down/README.md — the incident is the reason this migration adds
-- no enum value at all.
--
-- Order: drop the index and constraints before the columns they reference.

DROP INDEX IF EXISTS "accounts_validity_idx";
--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "accounts_validity_order";
--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "accounts_profile_slots_range";
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN IF EXISTS "valid_until";
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN IF EXISTS "valid_from";
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN IF EXISTS "profile_slots";
