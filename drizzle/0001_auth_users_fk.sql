-- Links public.users to Supabase Auth.
--
-- ADR-005 Decision 3: public.users.id holds the same value as auth.users.id, so
-- there is exactly one user identity in the system and nothing to synchronise.
--
-- Written by hand rather than declared in the Drizzle schema. Declaring a
-- cross-schema foreign key would make drizzle-kit attempt to manage auth.users,
-- which belongs to Supabase and must never appear in our migrations.
--
-- ON DELETE CASCADE: removing the auth identity removes the CRM profile. Audit
-- history survives regardless, because audit_logs.user_id is ON DELETE SET NULL
-- and carries actor_email as a denormalised fallback.
--
-- Requires the auth schema, so this migration runs against Supabase only. It
-- will fail on a vanilla PostgreSQL instance, which is expected and correct.

ALTER TABLE "users"
  ADD CONSTRAINT "users_id_auth_users_id_fk"
  FOREIGN KEY ("id")
  REFERENCES "auth"."users"("id")
  ON DELETE CASCADE
  ON UPDATE NO ACTION;
