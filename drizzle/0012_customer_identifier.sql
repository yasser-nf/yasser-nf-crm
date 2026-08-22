-- Customer identifier: a customer is reached by number OR by messaging handle.
--
-- The "Customer phone" field is in practice a customer identifier. Some
-- customers are known only by a handle such as @RAHIMOU, and some are abroad —
-- +974, +33, +971 — but the identity column accepted neither:
--
--   CHECK (phone_normalized ~ '^[0-9]{6,20}$')
--
-- International numbers already satisfied that pattern once the Identifier
-- Engine stopped rejecting them, because they normalise to plain digits. A
-- username does not, so this constraint is the one thing that genuinely has to
-- change in the database.
--
-- The replacement admits exactly two shapes:
--
--   663947116     Algerian national digits, unchanged since M02
--   97471601974   any other country, full international digits, no plus
--   @rahimou      a username, lower-cased
--
-- ALGERIAN IDENTITIES ARE NOT REWRITTEN. Every existing row is keyed on nine
-- national digits and still matches the first branch, so no backfill runs and
-- no customer is re-keyed. Normalising Algeria to a full international key
-- would have orphaned the entire existing customer base; that is why the engine
-- keeps the national short form for +213 alone.
--
-- The leading `@` is what keeps the two namespaces from colliding: no digit
-- string can equal a handle. Lower-case only is what stops @RAHIMOU and
-- @rahimou becoming two customers — the engine lower-cases before writing, and
-- this constraint refuses anything that did not go through it.
--
-- Widening a CHECK is not a rewrite: PostgreSQL validates the new constraint
-- against existing rows, all of which already pass, so this is a brief
-- ACCESS EXCLUSIVE lock and no table scan cost beyond the validation itself.

ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_phone_normalized_digits";
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_normalized_identity"
  CHECK ("customers"."phone_normalized" ~ '^([0-9]{6,20}|@[a-z0-9_.]{1,30})$');
