-- Rollback of 0003_customer_blocked_at.sql
--
-- Drops the Blocked flag. Any customer currently blocked silently becomes
-- unblocked, because the state has nowhere else to live.

ALTER TABLE "customers" DROP COLUMN IF EXISTS "blocked_at";
