# ADR-008
# Workforce And Identity Decisions

Status: ACCEPTED

Date: 2026-08-09

Owner: Yasser Saidi

Amends: 03_DATABASE.md, ADR-005

---

# Context

Milestone M06 builds user management, roles, sessions and the activity feed.

The project owner issued four locked decisions with the M06 continuation brief.
They were applied during implementation and referenced throughout the code as
"ADR-008", but the document itself was never written. This ADR records them
retroactively so those references resolve.

Recording them late is itself worth noting: the code cited a decision document
that did not exist for the length of a milestone. The decisions were real and
were followed; only the record was missing.

---

# Decision 1 — Three User Statuses

## Decision

`user_status` is exactly:

active

suspended

disabled

There is NO `blocked` status for users.

## Semantics

active

May authenticate and use the CRM.

suspended

May not authenticate. Existing sessions are left intact, so lifting the
suspension restores access without a new sign-in.

disabled

May not authenticate, AND every session is revoked immediately.

## Why no `blocked`

The M06 brief listed it but gave it no semantics distinct from suspended or
disabled. A third near-identical "cannot use the system" state would be
indistinguishable in practice, and the difference that does matter — what happens
to live sessions — is already carried by the two that exist.

Blocking belongs to customers, where it means something different and is stored
as `customers.blocked_at`.

## Archived

Not a fourth status. It is `deleted_at`, derived rather than stored, matching how
customer status works. A stored `archived` could disagree with the tombstone.

---

# Decision 2 — The CRM Never Owns A Password

## Decision

No password is ever accepted, generated, stored, logged or transmitted by this
application, in any form, for a CRM user.

There is no password column, no password field, no password parameter.

## Why

ADR-001 adopted Supabase Auth and ADR-005 Decision 3 made `auth.users` the only
credential store. A password reaching this codebase — even in transit, even
un-stored — would create a second place where credentials exist and a second
place they can leak.

The strongest form of "we do not store passwords" is that there is nowhere to
put one and no code path that receives one.

## Consequence

`supabase.auth.admin.createUser` is forbidden. It requires a password, which
would mean the CRM choosing or handling one.

`failure_reason` on `login_history` must never carry a password or anything
derived from one.

---

# Decision 3 — Invitation Is The Only Way A User Is Created

## Decision

Users are created exclusively through `supabase.auth.admin.inviteUserByEmail`.

Supabase emails an invitation link. The person sets their own password. The
`public.users` row is written by the CRM at invitation time.

## Why the CRM row is written immediately

`getCurrentUser` requires a `public.users` record and rejects an auth identity
without one. Deferring the row to first sign-in would make that first sign-in
fail silently — the person would hold a valid session the CRM refuses to
recognise.

## Failure handling

If the auth identity is created but the CRM row fails to write, the identity is
NOT rolled back. Deleting an auth user is destructive, and the recoverable state
is a pending invitation that can be re-sent. The failure is surfaced rather than
swallowed.

---

# Decision 4 — The Service Role Key Is Server-Only

## Decision

`SUPABASE_SERVICE_ROLE_KEY` lives in `config/env.server.ts`, which imports
`server-only`. It is never added to `config/env.ts`, never referenced from a
client component, and never serialised into a payload.

## Why

The key bypasses Row Level Security entirely. Anything holding it has
unrestricted access to every table, regardless of the policies added in
migration 0002.

The `server-only` import is the enforcement: a client component importing it,
directly or through a barrel, fails the build rather than shipping the key to a
browser. That guarantee is structural rather than a matter of remembering.

## Consequence

Any feature needing the key must execute on the server. M06 used it for
invitations; M07 extends that use to backup storage under the same constraint.

---

# Final Decision

These decisions are adopted. Changing any requires a new ADR and approval from
the project owner.

---

END OF ADR-008
