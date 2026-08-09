-- Brings login_history under the RLS policy from migration 0002.
--
-- 0002 revoked default privileges, so the new table already had no grants to
-- anon or authenticated and was never exposed. But RLS was not enabled on it:
-- ALTER DEFAULT PRIVILEGES governs grants, not row security, so every table
-- created after 0002 starts with RLS off.
--
-- That is worth fixing rather than relying on the grants alone. The whole point
-- of the two-layer model in 0002 is that restoring a grant must not silently
-- reopen a table, and without RLS this one would.
--
-- It is also the invariant the integration suite asserts — "RLS enabled on
-- every table" — which would now fail against nine tables with one uncovered.
--
-- Any future table needs the same two lines. There is no way to make RLS a
-- default in PostgreSQL.

ALTER TABLE "login_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Read is Super Admin only. 01_MASTER_RULES.md keeps Workers away from security
-- information, and a list of sign-in attempts is exactly that.
CREATE POLICY "login_history_read_admin" ON "login_history"
  FOR SELECT TO authenticated
  USING (public.is_super_admin());
--> statement-breakpoint

-- Any active CRM user may append, because the act of signing in has to be
-- recordable by the person doing it.
CREATE POLICY "login_history_insert" ON "login_history"
  FOR INSERT TO authenticated
  WITH CHECK (public.is_crm_user());

-- No UPDATE or DELETE policy exists, deliberately. A security log that can be
-- edited is not a security log, and an absent policy is stronger than one
-- returning false: there is nothing to edit rather than a rule to get wrong.
