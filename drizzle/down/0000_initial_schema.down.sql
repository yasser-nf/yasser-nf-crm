-- Rollback of 0000_initial_schema.sql
--
-- DESTRUCTIVE. Drops every table this migration created, and all data in them.
-- Intended for development and for aborting a failed initial deployment.
--
-- Tables are dropped in reverse dependency order so no foreign key blocks a
-- drop. Indexes, constraints and check constraints are removed automatically
-- with their tables, which is why none are listed individually.
--
-- Enum types must be dropped after the tables that use them, never before.

BEGIN;

DROP TABLE IF EXISTS "settings";
DROP TABLE IF EXISTS "backups";
DROP TABLE IF EXISTS "audit_logs";
DROP TABLE IF EXISTS "profile_events";
DROP TABLE IF EXISTS "profiles";
DROP TABLE IF EXISTS "accounts";
DROP TABLE IF EXISTS "customers";
DROP TABLE IF EXISTS "users";

DROP TYPE IF EXISTS "public"."backup_status";
DROP TYPE IF EXISTS "public"."backup_type";
DROP TYPE IF EXISTS "public"."audit_entity";
DROP TYPE IF EXISTS "public"."audit_action";
DROP TYPE IF EXISTS "public"."profile_event_type";
DROP TYPE IF EXISTS "public"."profile_status";
DROP TYPE IF EXISTS "public"."account_status";
DROP TYPE IF EXISTS "public"."user_status";
DROP TYPE IF EXISTS "public"."user_role";

COMMIT;
