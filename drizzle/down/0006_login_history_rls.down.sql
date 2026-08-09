-- Rollback of 0006_login_history_rls.sql
--
-- Removes the policies and disables row security on login_history.
--
-- The table remains unreachable by anon and authenticated afterwards, because
-- migration 0002 revoked their grants and this does not restore them. Reversing
-- this only removes the second layer, not the first.

DROP POLICY IF EXISTS "login_history_insert" ON "login_history";
--> statement-breakpoint
DROP POLICY IF EXISTS "login_history_read_admin" ON "login_history";
--> statement-breakpoint
ALTER TABLE "login_history" DISABLE ROW LEVEL SECURITY;
