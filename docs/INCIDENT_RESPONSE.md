# Incident Response

Version: 1.0 · Milestone M12

**No incident has ever been handled with this document.** It is a plan.

---

## Severity

| Level | Meaning | Example |
| ----- | ------- | ------- |
| **SEV1** | Data loss or exposure | Credentials leaked, database corrupted, backup found unrestorable |
| **SEV2** | Unusable | Cannot sign in, database unreachable, every page erroring |
| **SEV3** | Degraded | One module failing, exports broken, backups failing |
| **SEV4** | Cosmetic | Layout, wording, a slow page |

## First five minutes

1. `GET /api/health` — is the database reachable?
2. `/settings/system` — versions, migration state, health findings.
3. `/backups` — is there a recent verified backup? **Take a snapshot now** if
   the incident might involve data.
4. Record the time and what changed most recently.

## Credential exposure

The service role key bypasses RLS entirely — treat its exposure as SEV1.

1. Rotate in the Supabase dashboard.
2. Update the Vercel environment variable and redeploy.
3. Invitations and backup storage stop working until step 2 completes.

The anon key is public by design and ships in the browser bundle. Exposure is
not itself an incident — but M04.8 found it granted full table access, and
**that key has still not been rotated.**

If `ENCRYPTION_KEY` leaks, every stored account password is compromised. It
cannot be rotated without re-encrypting every row; no such tool exists.

## Suspected data corruption

1. Do not restore immediately. Take a snapshot of the current state first.
2. Verify the checksum of the backup you intend to use.
3. Preview the restore and read the counts. A preview showing far more changes
   than expected is evidence the backup is from the wrong point in time.
4. Restore only after the preview matches expectation. [UNTESTED path]

## Unauthorised access

1. `/users` — check presence and recent sign-ins.
2. `/users/[id]` — revoke sessions; disable the account.
3. `login_history` — failed attempts, IP, user agent.
4. `audit_logs` — every mutation, immutable, with before and after.

The audit log cannot be edited or deleted through the application. There is no
delete path in any service.

## What we cannot currently do

- No alerting. Nobody is paged; incidents are found by a person looking.
- No log aggregation. Logs are whatever the platform retained.
- No request correlation IDs, so one user's failing request cannot be traced
  across services.
- No rate limiting, so a credential-stuffing attempt is recorded but not slowed.
