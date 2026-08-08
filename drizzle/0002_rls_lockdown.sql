-- Row Level Security lockdown.
--
-- FIXES A LIVE VULNERABILITY found during M04.8.
--
-- Supabase grants ALL privileges on public tables to `anon` and `authenticated`
-- by default. RLS was not enabled and no policies existed, so every table was
-- fully readable AND writable by anyone holding the anon key — which is
-- NEXT_PUBLIC_SUPABASE_ANON_KEY, shipped in the browser bundle and visible in
-- devtools to any visitor.
--
-- Confirmed exploitable before this migration: GET /rest/v1/users returned the
-- super admin's name, email and role; GET /rest/v1/audit_logs returned the full
-- audit history. DELETE and TRUNCATE were equally available.
--
-- Two independent layers are applied, because either alone is insufficient:
--
--   1. REVOKE  — removes the privilege. Without a grant, PostgREST cannot touch
--                the table regardless of policies.
--   2. RLS     — row filtering. Applies if a grant is ever restored, so a future
--                `GRANT SELECT` cannot silently reopen the hole.
--
-- The application is unaffected. It connects as `postgres`, which has
-- rolbypassrls = true, so its queries never consult these policies. That is also
-- why RLS alone would NOT have fixed anything: the exposure is the grant.

-- ---------------------------------------------------------------------------
-- 1. Remove all privileges from the public-facing roles
-- ---------------------------------------------------------------------------
-- service_role is deliberately untouched: it is the server-side admin key and
-- is expected to be privileged. It must never reach a browser.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
--> statement-breakpoint

-- Future tables must not reinherit the default grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Enable RLS on every table
-- ---------------------------------------------------------------------------
-- With RLS enabled and no permissive policy matching, the default is DENY.

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "profile_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "backups" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Role helpers
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the lookup can read public.users while the caller cannot.
-- Without it, a policy on users that calls this function would recurse.
-- search_path is pinned; an unpinned search_path on a SECURITY DEFINER function
-- is a privilege-escalation vector.

CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.role::text
  FROM public.users u
  WHERE u.id = auth.uid()
    AND u.deleted_at IS NULL
    AND u.status = 'active'
  LIMIT 1
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(public.current_app_role() = 'super_admin', false)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.is_crm_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.current_app_role() IS NOT NULL
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.current_app_role() FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_super_admin() FROM public, anon;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_crm_user() FROM public, anon;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Policies
-- ---------------------------------------------------------------------------
-- Anonymous: no policy anywhere. RLS default-denies, so anon is refused by
-- omission rather than by a policy that could later be edited to permit.
--
-- These are inert while the grants above are revoked — a policy cannot permit
-- what no privilege allows. They exist so that restoring a grant does not
-- silently reopen the table, which is exactly how this hole appeared.

-- users: see yourself; super admins see everyone.
CREATE POLICY "users_select_self" ON "users"
  FOR SELECT TO authenticated
  USING (id = auth.uid() AND deleted_at IS NULL);
--> statement-breakpoint
CREATE POLICY "users_select_admin" ON "users"
  FOR SELECT TO authenticated
  USING (public.is_super_admin());
--> statement-breakpoint
CREATE POLICY "users_write_admin" ON "users"
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());
--> statement-breakpoint

-- Business data: any active CRM user may read; only super admins may write.
-- 01_MASTER_RULES.md restricts deletion and settings to Super Admin.
CREATE POLICY "customers_read" ON "customers"
  FOR SELECT TO authenticated USING (public.is_crm_user());
--> statement-breakpoint
CREATE POLICY "customers_write" ON "customers"
  FOR ALL TO authenticated
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
--> statement-breakpoint

CREATE POLICY "accounts_read" ON "accounts"
  FOR SELECT TO authenticated USING (public.is_crm_user() AND deleted_at IS NULL);
--> statement-breakpoint
CREATE POLICY "accounts_write" ON "accounts"
  FOR ALL TO authenticated
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
--> statement-breakpoint

CREATE POLICY "profiles_read" ON "profiles"
  FOR SELECT TO authenticated USING (public.is_crm_user());
--> statement-breakpoint
CREATE POLICY "profiles_write" ON "profiles"
  FOR ALL TO authenticated
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
--> statement-breakpoint

-- History is append-only for everyone. No UPDATE or DELETE policy exists at all,
-- which is stronger than a policy that returns false: there is nothing to edit.
CREATE POLICY "profile_events_read" ON "profile_events"
  FOR SELECT TO authenticated USING (public.is_crm_user());
--> statement-breakpoint
CREATE POLICY "profile_events_insert" ON "profile_events"
  FOR INSERT TO authenticated WITH CHECK (public.is_crm_user());
--> statement-breakpoint

-- 01_MASTER_RULES.md: audit logs are immutable and Workers may not read them.
CREATE POLICY "audit_logs_read_admin" ON "audit_logs"
  FOR SELECT TO authenticated USING (public.is_super_admin());
--> statement-breakpoint
CREATE POLICY "audit_logs_insert" ON "audit_logs"
  FOR INSERT TO authenticated WITH CHECK (public.is_crm_user());
--> statement-breakpoint

-- Backups and settings: Super Admin only. Workers are explicitly excluded.
CREATE POLICY "backups_admin_only" ON "backups"
  FOR ALL TO authenticated
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
--> statement-breakpoint
CREATE POLICY "settings_admin_only" ON "settings"
  FOR ALL TO authenticated
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
