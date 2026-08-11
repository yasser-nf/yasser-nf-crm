# Runbook

Version: 1.0 · Milestone M12

Operational procedures. Marked **[UNTESTED]** where the procedure has never been
performed against a real incident.

---

## Health

| Probe | Meaning | Action on failure |
| ----- | ------- | ----------------- |
| `GET /api/health?probe=liveness` | Process is up | Restart |
| `GET /api/health` | Database reachable within 2s | Withhold traffic; check Supabase |

`/settings/system` shows versions, migration state, storage and health for a
signed-in Super Admin.

## Database unreachable

Symptom: `/api/health` returns 503; pages show error states rather than crashing.

1. Check the Supabase project status.
2. Check connection count. The session pooler caps this project at **15
   clients**; the application pool holds up to 10.
3. `EMAXCONNSESSION` means exhaustion, not a code fault. Stop the dev server if
   one is running against the same project.

**This has occurred twice**, both times caused by the test suite competing with
a dev server. Integration tests now run serially.

## Backup failed

1. `/backups` — a failed row carries `error_message`.
2. Common causes: `SUPABASE_SERVICE_ROLE_KEY` missing, storage bucket absent.
3. Verify integrity of the most recent good backup before relying on it.

## Restore [UNTESTED]

**The apply path has never been executed.** Preview, checksum verification and
corruption refusal are verified; applying is not.

1. Take a snapshot first — the UI does this automatically.
2. Preview. Read the create/update/delete counts and the orphan report.
3. Confirm only if the numbers match expectation.
4. Everything runs in one transaction; a failure rolls back entirely.

Do not perform a first restore against production. Use a scratch project.

## Account locked out / lost access

There is no self-service password reset flow in the CRM — Supabase Auth owns
credentials. Reset from the Supabase dashboard.

If the last Super Admin is lost, the guard in `usersService` prevents reaching
that state through the application. Recovery requires direct database access.

## Suspicious activity

1. `/users/[id]` — sessions and login history per user.
2. Revoke sessions individually or all at once.
3. Disable the user: refuses sign-in **and** revokes every session.
4. Suspend instead if access should return without a new sign-in.
5. `login_history` records failed attempts with IP and user agent.

**Failed sign-ins are recorded but nothing acts on them.** No rate limiting, no
automatic lockout. The setting exists and is labelled "not enforced".

## Data loss

1. Stop writes if possible.
2. `/backups` — find the most recent `verified` backup.
3. Verify its checksum before trusting it.
4. Restore preview, then apply [UNTESTED].

Retention keeps the last 30 by default; restore points and snapshots are never
pruned.
