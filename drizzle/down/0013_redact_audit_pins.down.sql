-- Reverses 0013_redact_audit_pins.sql — by doing nothing, deliberately.
--
-- IRREVERSIBLE BY DESIGN. The forward migration replaced leaked customer PINs
-- in audit_logs with "[redacted]". The original values are not stored anywhere
-- the database can reach, and they must not be: bringing them back is exactly
-- the exposure 0013 exists to end.
--
-- Nothing else in 0013 needs undoing. It changed no schema, dropped no row and
-- touched no column other than the "pin" value inside two jsonb snapshots.
--
-- If a PIN is ever genuinely needed for a past event, the source of truth is
-- the profiles table (the current PIN) — never the audit trail. Restoring an
-- old backup to recover one would also restore every other redacted PIN in it;
-- see the M01.5 report, Remaining Issues, on backup artifacts.

SELECT 1;
