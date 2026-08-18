-- M13 Phase B: account inventory metadata.
--
-- Three columns, two checks, one index. No new tables, no enum change, and no
-- RLS change — new columns inherit accounts_read / accounts_write from
-- 0002_rls_lockdown.sql, because RLS is granted per table and not per column.
--
-- Every column is defaulted or nullable, so the accounts that already exist are
-- correct the moment this runs and no backfill is required.
--
--   profile_slots  how many of the five profile rows are sellable, 1..5.
--                  DEFAULT 5 means every existing account keeps exactly today's
--                  behaviour. The five rows themselves are untouched:
--                  01_MASTER_RULES.md still holds, and accountsRepository.create
--                  still writes five.
--
--   valid_from     when the account's own coverage starts. Nullable, and
--   valid_until    when it ends. NULL means open-ended rather than expired —
--                  the distinction matters, because treating NULL as expired
--                  would make every account already in the table unallocatable.
--
-- valid_until is the column the allocation rule actually needs
-- (requested_duration_days <= remaining_days). valid_from is provenance: without
-- it the duration an operator originally bought is unrecoverable after creation.
--
-- WHAT IS DELIBERATELY ABSENT: a `not_for_sale` profile status.
--
-- An earlier draft of this migration added one, so that the six existing queries
-- filtering on `status = 'available'` would exclude unsellable slots for free.
-- It was withdrawn because that status would have been a second source of truth
-- for a fact already recorded by profile_slots, and the two could drift:
-- profileUpdateSchema permits writing `status`, so a profile update could return
-- a parked slot to stock without touching profile_slots, and nothing in the
-- database would object.
--
-- Sellability is therefore DERIVED, everywhere, from
--
--     profile_number <= accounts.profile_slots
--
-- expressed once in lib/drizzle/predicates.ts and reused by every query.
-- ADR-013 Decision 2.

ALTER TABLE "accounts" ADD COLUMN "profile_slots" smallint DEFAULT 5 NOT NULL;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "valid_from" date;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "valid_until" date;
--> statement-breakpoint

-- Mirrors profiles_number_range. An account can never sell more than the five
-- profile rows it physically has, and never fewer than one.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_profile_slots_range"
  CHECK ("profile_slots" BETWEEN 1 AND 5);
--> statement-breakpoint

-- Coverage cannot end before it starts. Permits either side being null, exactly
-- as profiles_expiry_after_sale does for a sale.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_validity_order"
  CHECK ("valid_until" IS NULL OR "valid_from" IS NULL OR "valid_until" >= "valid_from");
--> statement-breakpoint

-- Allocation reads this on every Quick Prepare and every Quick Replace. Partial,
-- so it indexes only the live rows the allocator can actually choose.
CREATE INDEX IF NOT EXISTS "accounts_validity_idx" ON "accounts" USING btree ("valid_until")
  WHERE "deleted_at" IS NULL;
