-- Reverses 0014_notifications.sql.
--
-- Dropping the table takes its policy, indexes and constraints with it. Every
-- notification is lost, which is acceptable and worth stating: a notification
-- is a message about an event, not the event. The events themselves — problem
-- creation, assignment, resolution, reopening — remain in `issues` and in
-- `audit_logs`. Nothing else references this table.

DROP POLICY IF EXISTS "notifications_own_rows_select" ON "notifications";
--> statement-breakpoint
DROP TABLE IF EXISTS "notifications";
