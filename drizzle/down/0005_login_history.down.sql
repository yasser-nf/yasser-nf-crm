-- Rollback of 0005_login_history.sql
--
-- DESTRUCTIVE. Drops the authentication history table and everything in it.
--
-- This is security data: failed sign-in attempts, session revocations and
-- invitation events. Dropping it destroys the only record of who tried to reach
-- the system, so it should be exported before this runs anywhere real.
--
-- Indexes and the foreign key are removed with the table.

DROP TABLE IF EXISTS "login_history";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."auth_event_type";
