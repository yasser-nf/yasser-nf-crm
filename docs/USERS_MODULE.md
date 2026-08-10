# Users Module

Version: 1.0
Milestone: M06

Authority: `.ai/` decides, this describes.

---

## 1. Responsibilities

| Owns | Does not own |
| ---- | ------------ |
| Authorization decisions about people | Authentication — Supabase Auth is the only identity provider |
| Role assignment and the permission matrix | Passwords, at any point, in any form |
| User status (`active` / `suspended` / `disabled`) | The audit log — that is `modules/audit` |
| Session listing and revocation | Customer, account or profile state |
| Login history | Presence storage — presence is derived |
| The per-user activity feed | |

This is the security centre of the application. Every authorization decision
about a person is made in `services/users.service.ts` and nowhere else.

---

## 2. Architecture

```
app/(app)/users/*            page composition only, no decisions
  └── modules/users (barrel)
        ├── components/      client rendering
        ├── actions/         network boundary (ADR-006 D3)
        ├── services/        authorization + business rules
        │     ├── users.service.ts      server-only
        │     ├── sessions.service.ts   server-only
        │     ├── activity.service.ts   server-only
        │     └── presence.ts           pure, unit tested
        ├── repositories/    data access, never exported
        └── validation/      Zod schemas
```

Repositories are **not** exported from the barrel. Every operation in this
module carries an authorization check, and exposing a repository would offer a
route past it — a distinction from earlier modules, where the repository existed
before its service.

`presence.ts` is separate from `users.service.ts` because the service imports
`server-only`, which throws outside a server environment. Presence is pure, so
it lives where it can be unit tested — the same split as `customer-status.ts` in
M05.

### Sessions are read as raw SQL

`repositories/sessions.repository.ts` queries `auth.sessions` and
`auth.refresh_tokens` with raw SQL rather than Drizzle table objects.

This is deliberate. Declaring the `auth` schema in Drizzle would put it under
drizzle-kit's control, and the next `generate` would emit migrations against
tables Supabase owns. The CRM reads that schema; it must never propose changes
to it.

---

## 3. RBAC

Two roles, defined in `src/config/roles.ts`.

| | Super Admin | Worker |
| - | ----------- | ------ |
| Permissions | all 22 | 9, by explicit allow-list |
| User management | yes | no |
| Delete accounts | yes | no |
| Modify permissions | yes | no |

Worker permissions are an **allow-list**, not a deny-list. A permission added in
a later milestone is denied to Workers until someone names it — the failure mode
of forgetting is "too little access", not "too much".

### Where the check happens

In the service, before anything else:

```ts
const permitted = requirePermission(actor, PERMISSIONS.MANAGE_USERS, "view users");
if (!permitted.ok) return permitted;
```

Not in the component, and not in the action. A Server Action is a POST endpoint
that anyone holding a session can call directly, so a hidden button is
presentation, not protection. Pages render the refusal the service returns; they
never decide.

### Rules that outrank the permission check

| Rule | Why it cannot be a database constraint |
| ---- | -------------------------------------- |
| Nobody changes their own role | Self-promotion is the escalation the check exists to stop |
| Nobody suspends or disables themselves | Locks the door from the inside |
| Nobody archives themselves | Same |
| The last active Super Admin cannot be demoted, suspended, disabled or archived | Depends on a count across other rows at the moment of the change |

Losing the last Super Admin has no recovery path through the application. That
guard is the reason this module has no `delete` method at all.

---

## 4. Statuses

Exactly three, locked by the M06 brief. There is **no** `blocked` status for
users — blocking belongs to customers.

| Status | Sign-in | Existing sessions |
| ------ | ------- | ----------------- |
| `active` | allowed | kept |
| `suspended` | refused | **kept** |
| `disabled` | refused | **revoked immediately** |

Suspension is reversible without disruption: lifting it restores access with no
new sign-in. Disabling is the one that ends sessions, so it is the correct
response to a compromised or departing account.

Archived is **derived** from `deleted_at IS NOT NULL`, not a fourth status.
Archiving soft-deletes, and revokes every session.

`getCurrentUser` requires `active`, so both denial states are enforced at the
authentication boundary rather than only in the UI.

---

## 5. Invitation Flow

**The CRM never owns a password.** ADR-008 Decision 2, and the reason
`admin.createUser` appears nowhere in this codebase — it requires a password,
which would mean the CRM choosing or handling one.

```
Super Admin submits name + email + role
  → usersService.invite()
      → permission check
      → duplicate email check
      → supabase.auth.admin.inviteUserByEmail(email)   ← no password
      → public.users row created with the returned auth id
      → audit entry + login_history "invitation_sent"
  → Supabase emails a link; the person sets their own password
```

There is no password field on the invite form, and there will never be one — its
existence is what would make storing one possible.

The `public.users` row is written immediately rather than on first sign-in.
Without it, `getCurrentUser` would reject the new person as an identity with no
CRM record and their first sign-in would fail silently.

If the CRM row fails to write after the invite succeeds, the auth identity is
**not** rolled back. Deleting an auth user is destructive; the recoverable state
is a pending invite that can be re-sent. The failure is surfaced, not swallowed.

The service role key is read only inside `src/lib/supabase/admin.ts`, which is
`server-only`. It is never imported into client code and never serialized.

---

## 6. Session Flow

Supabase Auth sessions are the only sessions. The CRM does not keep a sessions
table of its own.

| Operation | Behaviour |
| --------- | --------- |
| List | reads `auth.sessions` for one user |
| Revoke one | **verifies the session belongs to the stated owner first**, then deletes |
| Revoke all | deletes every session for the user |

The ownership check on single revocation matters: without it, a valid session id
from anywhere would be revocable by id alone.

Revocation is also triggered indirectly — by disabling a user, and by archiving
one.

### Presence

Derived from session activity, never stored.

| State | Last activity |
| ----- | ------------- |
| `online` | within 5 minutes |
| `idle` | within 30 minutes |
| `offline` | older, or never |

A `last_seen` column would need writing on every request — a write per page view
to answer a question nobody is asking most of the time — and would still be
wrong the moment a process died.

A timestamp slightly in the future reads as `online`, not `offline`. Clock skew
between the database and the application is ordinary, and the session
demonstrably exists.

The list computes presence in **two** queries: the page, plus one grouped read
of session activity. Never per row.

Presence degrades rather than fails: if the session read breaks, everyone shows
offline and the list still renders.

---

## 7. Activity Flow

Two separate records, kept separate on purpose.

| | Audit Log | Activity Feed | Login History |
| - | --------- | ------------- | ------------- |
| Question | what changed | what someone did | who signed in |
| Table | `audit_log` | derived from `audit_log` | `login_history` |
| Scope | every entity | one user | one user or email |

`activityForUser` reads both sources through a SQL `UNION`, so ordering happens
in the database before the limit is applied — merging two already-limited lists
in application code would drop entries that belong on the page.

### Why `login_history` exists

Supabase's `auth.audit_log_entries` was measured **empty — 0 rows against 12
live refresh tokens**. Depending on it would have produced a permanently blank
screen. The dedicated table is the evidence-backed alternative, not a
preference.

It is append-only, and both `user_id` and `email` are nullable so a failed
attempt against an address that matches no user is still recorded.

`recordAuthEvent` never fails its caller. A sign-in must not break because a log
write did.

---

## 8. Security

| Control | Where |
| ------- | ----- |
| Permission check before every operation | `users.service.ts` |
| Service role key server-only | `lib/supabase/admin.ts` |
| No password handling anywhere | by construction — no field, no parameter, no column |
| `REVOKE ALL` + RLS + explicit policies on `login_history` | migrations 0005, 0006 |
| Session ownership verified before revocation | `sessions.service.ts` |
| Last-Super-Admin guard | `users.service.ts` |
| Self-lockout refused | `users.service.ts` |
| No delete method | by omission |

### Two-layer model

Every table added in this milestone received the same treatment as the rest:
grants revoked from `anon` and `authenticated`, row security enabled, and
explicit policies. Migration 0006 exists because 0005 was incomplete —
`ALTER DEFAULT PRIVILEGES` governs grants, not row security, so `login_history`
shipped briefly with RLS off. The integration test now asserts RLS on all nine
tables, so the same gap cannot reopen quietly.

### Down migrations

0005 and 0006 both have verified down migrations, per the standing rule.

---

## 9. Tests

| File | Covers |
| ---- | ------ |
| `tests/unit/presence.test.ts` | 15 cases — thresholds, boundaries, null, clock skew |
| `tests/unit/roles.test.ts` | 44 cases — permission matrix, Worker allow-list, status semantics |
| `tests/integration/rbac-and-rls.test.ts` | anonymous access refused, RLS enabled on all 9 tables |

The presence tests fix the thresholds deliberately: a later change that starts
writing a `last_seen` column fails there rather than passing quietly.

---

## 10. Known Gaps

| Gap | Consequence |
| --- | ----------- |
| No Worker user exists | Worker-side RBAC is enforced in code and unit tested, but has never been exercised by a real Worker session |
| Anon key not rotated | Pre-existing from M04.9; the exposure it created is closed, the key itself is unchanged |
| `permissions` on `UserDetail` returns `[]` | Placeholder; the role matrix is the live source |
