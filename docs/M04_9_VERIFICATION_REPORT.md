# M04.9 Verification Report

Date: 2026-08-09
Target: live Supabase project

**Partial milestone.** Parts 1, 3, 4 (server-side), 5, 8 delivered. Parts 2, 6, 7
(partial) and 9 are not complete — detail below.

---

## CRITICAL — The Key Was Not Rotated

The brief states the exposed browser key has been rotated. **It has not.**

`.env.local` holds the identical `sb_publishable_bZg…` key that was confirmed
exploitable in M04.8. Verified two ways:

- String comparison against the prefix recorded during the M04.8 exploit.
- A live call to `/auth/v1/token`, which returned
  `{"error_code":"invalid_credentials"}` — the API key was **accepted**; only the
  password was rejected. An invalid key returns `401 Invalid API key`.

**The exposed key is still live and functional.**

The RLS lockdown from M04.8 means it can no longer read data, so the practical
risk is much reduced. But a key that was published with full write access should
not remain valid. Rotate it in the Supabase dashboard and update `.env.local`.

### Secret scan — CLEAN

| Pattern | Result |
| ------- | ------ |
| `sb_publishable_` / `sb_secret_` | Not in git history |
| JWT prefix `eyJhbGciOiJIUzI1NiIs` | Not in git history |
| Connection strings | Only placeholders, in `.env.example`, `ci.yml`, `env.server.ts` |
| `service_role` | One occurrence — the word in the RLS migration, not a key |

**No secret has ever been committed.** `.env.local` is untracked.

**New:** `SUPABASE_SERVICE_ROLE_KEY` now exists in `.env.local`. It is untracked
and unused by the application, but it bypasses RLS entirely — it must never be
referenced from client code or added to `config/env.ts`.

---

## Bugs Found And Fixed

### BUG-04 · An Auth identity alone granted application access · HIGH · FIXED

`getCurrentUser` accepted any valid Supabase Auth session. Anyone who obtained
an identity — through an invite, a sign-up flow, or the dashboard — became a
valid application user with no CRM record.

Now two independent gates are required: a valid session **and** an active,
non-deleted `public.users` row. A database failure while resolving the role
returns null rather than a default, so an unreadable role cannot become an
authorization bypass.

### BUG-05 · Role was never read, so RBAC was inert · MEDIUM · FIXED

`toAppUser` built a user with no role, and `assertMayDelete` therefore refused
everyone. `AppUser` now carries `role`, read from `public.users`.

Role is deliberately **not** copied into Supabase Auth metadata — a second copy
of an authorization decision can disagree with the real one. A test asserts no
`role` key exists in `raw_app_meta_data` or `raw_user_meta_data`.

Consequence: `signIn` now returns an `AuthIdentity` rather than an `AppUser`,
and `AuthProvider` no longer constructs one client-side. The browser cannot
invent an authorization claim.

### BUG-06 · `last_login_at` was never written · LOW · FIXED

`recordSuccessfulLogin` is called from a Server Action after Supabase accepts
the credentials. It records whoever the **server** resolves from the session
cookie and ignores caller input, so it cannot be used to forge a login, and a
failed attempt has no session to record.

---

## Test Results

**126 automated tests passing** (105 unit + 21 integration), plus 42 E2E.

### RLS — VERIFIED

| Check | Result |
| ----- | ------ |
| Anonymous SELECT on all 8 tables | ✅ denied |
| Anonymous INSERT | ✅ denied |
| Anonymous DELETE | ✅ denied |
| RLS enabled on all 8 tables | ✅ |
| Grants to anon / authenticated | ✅ zero |
| Policies on every table | ✅ 15 |
| `profile_events` / `audit_logs` UPDATE or DELETE policy | ✅ none exist |
| `SECURITY DEFINER` helpers pin `search_path` | ✅ |

These now run in the permanent suite, so SEC-01 cannot silently return.

### Database — VERIFIED

Every CRM user maps to an Auth identity · role not duplicated into Auth metadata
· history tables have no `updated_at` or `deleted_at` · soft delete present on
exactly `accounts`, `customers`, `users`.

### Authorization — PARTIAL

Server-side enforcement is implemented and typechecked: `assertMayDelete` reads
the real role and `getCurrentUser` fails closed.

**Not verified:** no Worker user exists, and creating one requires setting a
password. So "a Worker cannot delete an account" is correct by construction and
by type, but has never been executed.

---

## UNVERIFIED

| Item | Why |
| ---- | --- |
| Login, dashboard, sidebar, topbar, accounts list, account details, Quick Prepare, profile editing, logout, session persistence, refresh | Signing in requires a password the assistant may not handle |
| Worker RBAC behaviour | No Worker user exists |
| Authenticated RLS (worker / super admin) | Requires a signed-in JWT |
| Migration rollback | Not attempted — see below |
| Account-level timeline events | Not implemented |

### Rollback — NOT ATTEMPTED

The database holds the super admin record and real audit history. Running the
down migrations would drop all eight tables and destroy that history, which is
append-only by design.

Per the brief — *never destroy data merely to make a test pass* — this was not
executed. It should be verified against a scratch Supabase project instead.

---

## Remaining Risks

| Risk | Severity |
| ---- | -------- |
| Exposed anon key still live | HIGH |
| Authenticated UI never exercised | HIGH |
| Worker role never tested against a real Worker | MEDIUM |
| Rollback unverified | MEDIUM |
| Service role key present locally, unused, bypasses RLS | MEDIUM |
| No rate limiting on login | MEDIUM |
| Account-level changes still absent from the timeline | LOW |
