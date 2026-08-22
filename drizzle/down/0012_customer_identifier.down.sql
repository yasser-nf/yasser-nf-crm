-- Reverses 0012_customer_identifier.sql.
--
-- POTENTIALLY DESTRUCTIVE, in a way the other down scripts are not: it does not
-- delete a row, it refuses to apply while certain rows exist.
--
-- Restoring the digits-only CHECK fails outright if any customer has been saved
-- with a username identity, because PostgreSQL validates a new constraint
-- against the existing table. That failure is correct and deliberate — silently
-- dropping those customers to make a rollback succeed would be far worse.
--
-- To roll back after usernames are in use, decide what happens to those
-- customers first:
--
--   select id, name, phone_original from customers
--   where phone_normalized like '@%' and deleted_at is null;
--
-- Either give them a phone number, or soft-delete them, and then run this. The
-- partial unique index is scoped to live rows, so a soft-deleted username row
-- still blocks the constraint — it has to be re-keyed or hard-deleted.
--
-- Numbers need no attention. Both Algerian national digits and full
-- international digits satisfy the old pattern, so re-narrowing the constraint
-- leaves every phone customer valid.

ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_phone_normalized_identity";
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_normalized_digits"
  CHECK ("customers"."phone_normalized" ~ '^[0-9]{6,20}$');
