-- Rollback of 0001_auth_users_fk.sql
--
-- Drops the link between public.users and auth.users.
-- Leaves both tables and all data intact.

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_id_auth_users_id_fk";
