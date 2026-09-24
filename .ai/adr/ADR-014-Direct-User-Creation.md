# ADR-014
# Direct User Creation

Status: ACCEPTED

Date: 2026-09-24

Owner: Yasser Saidi

Milestone: M02 — Users V2

Supersedes: ADR-008 Decision 2 (in part) and ADR-008 Decision 3

---

# Context

ADR-008 made invitation the only way a user is created, and forbade the CRM
from ever handling a password. In practice invitations depended on email
delivery the project does not control: Supabase's built-in SMTP allows a few
messages an hour, links expire after about a day, and every invitation needed
its own redirect and callback machinery (`/auth/callback`,
`/auth/set-password`) before the person could work.

The M02 brief, issued by the project owner, replaces this with direct creation:
an administrator enters name, email, password and role, and the person can sign
in immediately. ADR-008 says any change to its decisions needs a new ADR and the
owner's approval; this is that ADR, and the M02 brief is that approval.

---

# Decision 1 — Users are created directly

`usersService.create` calls `supabase.auth.admin.createUser` with
`email_confirm: true`, then writes the `public.users` row with the id Supabase
returned. No email is sent. The account works at once.

Nothing but email and password is sent to Supabase. Role stays in
`public.users` only (ADR-005 Decision 3); a copy in Supabase's user metadata
would be a second answer that could disagree.

Creating a user requires `MANAGE_USERS`. Assigning Super Admin additionally
requires `MODIFY_PERMISSIONS` — the permission `changeRole` already requires to
grant a role. Both belong to Super Admin alone today, so the effect is: Super
Admins create users of either role, and nobody else creates anyone. Both checks
run in the service; the form only mirrors them.

---

# Decision 2 — The password passes through, once, and is never kept

Replaces the "no password is ever accepted or transmitted" half of ADR-008
Decision 2. The rest of that decision stands: the CRM stores no password.

The administrator's password travels from the form, through the Server Action,
to the service, and from there only to Supabase Auth, which hashes and stores
it. It is never:

- stored in `public.users` or any application table (there is no column for it)
- written to the audit log — the M01.5 sanitizer's allow-list for `user` does
  not include it, and its deep redaction would catch it anyway
- logged — Supabase errors are reduced to code and status before logging, and
  any message is scrubbed of the password before it goes into an error
- returned to the browser — the action returns the stored row

The minimum length is the configured `security.passwordMinLength`, read by the
service from stored settings; the maximum is bcrypt's 72. The caller cannot
supply its own policy.

The service role key remains server-only (ADR-008 Decision 4, unchanged).

---

# Decision 3 — Partial creation is compensated

Replaces the failure handling in ADR-008 Decision 3.

Two writes in two systems cannot share a transaction. The order is fixed by the
foreign key from `public.users.id` to `auth.users.id`: Supabase first, then the
CRM row. If the CRM row fails, the service deletes the auth identity it has
just created — by the id Supabase returned for it, and nothing else. The
identity has never been used, so nothing is lost, and no auth user is left
without a CRM record.

ADR-008 rejected rollback because deleting an auth user is destructive and a
pending invitation could be re-sent. Neither holds any more: a directly created
identity has no pending state to recover, and an orphan would hold its email
address indefinitely.

If the compensating delete itself fails, the service logs the orphaned id and
returns an error that says so. It never retries against, or deletes, any other
user. A duplicate address is refused before anything is written, and Supabase
refusing an address means it created nothing to undo.

---

# Decision 4 — The invitation machinery stays for people already invited

Removed: `usersService.invite`, `inviteUserAction`, the invite form and
`inviteUserSchema`. Nothing creates invitations any more.

Kept:

- `/auth/callback` and `/auth/set-password` — outstanding invitation links sent
  before this change land there, and the callback also accepts
  `type=recovery` links.
- `usersService.resendInvite` and its button — shown only for someone whose
  invitation is still unaccepted, which no directly created user ever is.
- Invitation status derivation — a directly created user has no `invited_at`
  and a confirmed email, so it reads as `accepted` and shows no badge.

These can be removed once no unaccepted invitation remains in production.

---

# Consequences

- ADR-008 Decisions 2 and 3 carry a superseded note pointing here.
- Existing users are untouched: no migration, no password reset, no role or
  session change. No schema change was needed.
- A real Supabase password sign-in cannot be exercised in the isolated test
  database. It should be verified once after deployment, with the owner's
  approval, since doing it creates a real user.

---

END OF ADR-014
