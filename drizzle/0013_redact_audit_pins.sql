-- Redact customer profile PINs from historical audit snapshots.
--
-- DATA ONLY. No schema change: the 0013 snapshot is identical to 0012's.
--
-- WHY
--
-- Until M01.5 the audit service stripped only three field names, and only at
-- the top level of a snapshot. `pin` was not one of them, and profiles.service
-- passed whole ProfileRows, so every profile edit wrote the customer's PIN into
-- audit_logs.before / after in plaintext. M01 counted 243 such rows; by M01.5
-- it was 249, because production keeps writing them until the code fix ships.
--
-- WHAT THIS DOES
--
-- Replaces the VALUE of a top-level "pin" key with "[redacted]", in both
-- snapshots, on every row that holds one. The row itself is untouched — who
-- acted, on what, when and with which action all survive. That is the same
-- shape account passwords already have in this table ("passwordEncrypted":
-- "[redacted]"), so history reads consistently.
--
-- A JSON null PIN is left as null: it discloses nothing, and turning it into
-- "[redacted]" would falsely suggest a PIN had existed.
--
-- WHY ONLY TOP LEVEL
--
-- Verified against production before this was written: every PIN in the table
-- is a top-level key on an entity = 'profile' row (whole-row snapshots). No
-- nested PIN, and no token, secret, cookie or OTP key exists anywhere in the
-- history. A recursive rewrite would add risk for no observed case. The check
-- at the end enforces the top-level claim, so a database where it is untrue
-- fails this migration instead of silently keeping a PIN.
--
-- WHY THIS IS SAFE TO MUTATE AN APPEND-ONLY TABLE
--
-- audit_logs is append-only by convention (no trigger or rule enforces it).
-- Redacting a leaked secret is the one mutation an audit log should permit.
-- Verified that nothing in the application reads a PIN out of audit_logs: the
-- problem timeline reads issue status / assignedTo / severity / reopenCount,
-- settings history reads setting keys, and the dashboard and reports read only
-- entity, action and timestamps.
--
-- IDEMPOTENT. Already-redacted values are excluded, so a second run changes
-- nothing. IRREVERSIBLE by design — see down/0013_redact_audit_pins.down.sql.
--
-- ORDER OF OPERATIONS IN PRODUCTION: deploy the code that stops writing PINs
-- FIRST, then run this. Run it first and the rows written in between keep
-- their PINs.
--
-- WHAT IT CANNOT REACH: backup artifacts already in Supabase Storage contain
-- audit_logs rows as they were when taken. They still hold PINs, and restoring
-- one would write them back. See M01.5 report, Remaining Issues.

UPDATE "audit_logs"
SET "before" = jsonb_set("before", '{pin}', '"[redacted]"'::jsonb)
WHERE "before" ? 'pin'
  AND jsonb_typeof("before" -> 'pin') <> 'null'
  AND "before" ->> 'pin' <> '[redacted]';
--> statement-breakpoint
UPDATE "audit_logs"
SET "after" = jsonb_set("after", '{pin}', '"[redacted]"'::jsonb)
WHERE "after" ? 'pin'
  AND jsonb_typeof("after" -> 'pin') <> 'null'
  AND "after" ->> 'pin' <> '[redacted]';
--> statement-breakpoint
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*) INTO remaining
  FROM "audit_logs"
  WHERE ("before" ? 'pin' AND jsonb_typeof("before" -> 'pin') <> 'null' AND "before" ->> 'pin' <> '[redacted]')
     OR ("after"  ? 'pin' AND jsonb_typeof("after"  -> 'pin') <> 'null' AND "after"  ->> 'pin' <> '[redacted]');

  IF remaining > 0 THEN
    RAISE EXCEPTION '0013_redact_audit_pins: % audit row(s) still hold a PIN after redaction', remaining;
  END IF;
END
$$;
