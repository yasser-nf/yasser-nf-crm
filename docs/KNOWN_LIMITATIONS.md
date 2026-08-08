# Known Limitations

As of M04.5. Everything here is a deliberate, recorded gap — not something
waiting to be discovered.

---

## 1. Security

### RLS is not enabled on any table — HIGH

`03_DATABASE.md` requires Row Level Security on all business tables. No policy
exists on any of the eight.

Today the application connects as `postgres` through the pooler and enforces
authorization in the service layer, which ADR-002 records as the primary
mechanism with RLS as defense-in-depth. The defense-in-depth half is missing:
anything holding the connection string has unrestricted access, and the Supabase
anon key reaches PostgREST directly, bypassing our service layer entirely.

**Until RLS exists, the anon key must be treated as a database-wide read
credential.**

### Audit immutability is convention, not enforcement — MEDIUM

No update or delete method exists for `audit_logs`, and none should. But nothing
at the database level prevents one. A `REVOKE UPDATE, DELETE` on the application
role would make it structural; that needs a decision about which role the app
connects as.

### Secrets in snapshots rely on one function — MEDIUM

`auditService` strips `passwordEncrypted` centrally and this is verified. But a
caller writing directly to `auditRepository`, or putting a secret in
`profile_events.metadata`, would bypass it. Convention, enforced in one place
rather than by the type system.

### Encryption key rotation is unrecoverable — MEDIUM

Changing `ENCRYPTION_KEY` after accounts exist makes every stored password
permanently unreadable. There is no re-encryption tooling. Documented in
`.env.example`; the key must be backed up before real data is entered.

---

## 2. Unverified At Runtime

### The authenticated UI has never been exercised — HIGH

Signing in requires handling a password, which is outside what the assistant may
do. The following remain unverified **as rendered behaviour**, though their
underlying services are verified:

- Login success, session persistence, session refresh, logout
- Dashboard render
- Sidebar: 10 items, collapse, persistence, active-route highlight
- Accounts list, filters, sorting, pagination, mobile cards
- Account details, profile cards, password reveal control
- Quick Prepare wizard, warning step, copy button
- Replace Account dialog
- Keyboard navigation, focus order, dialog focus trapping

Every service behind these screens passed at the data layer. What is untested is
the rendering and interaction on top.

### The retry policy has never fired — LOW

It is now reachable (it was not, before BUG-01), but no transient failure
occurred during testing. Correct by inspection only.

### Rollback SQL has never executed — MEDIUM

`drizzle/down/*.down.sql` is hand-written because drizzle-kit generates none.
Testing it means dropping all eight tables. It has not been run.

---

## 3. Functional Gaps

### `users.last_login_at` is never written — LOW

`usersRepository.recordLogin` is correct and unreachable — nothing calls it. The
column specified by `03_DATABASE.md` stays null forever.

### Account deletion is refused for everyone — MEDIUM

`assertMayDelete` fails closed because the signed-in `AppUser` carries no role.
`public.users.role` now exists and holds `super_admin`, so the deferral in
ADR-005 can be lifted — but `toAppUser` does not read it yet. Archive is
unaffected.

### `expiring_soon` and `expired` are never set — MEDIUM

Both enum values exist and nothing writes them. They are functions of
`expiration_date` and today's date, and the scheduled sweep that would apply
them does not exist. A subscription that has ended still reads as `sold`.

### `health_score` is always 100 — MEDIUM

The Smart Stock Engine ranks by health, and every account has the default. Until
problem history feeds the score, ranking is effectively by account age.

### No orders table — MEDIUM

ADR-007 Decision 2. Sales history lives only in `profile_events`, which answers
"what happened to this profile" but not "what did this customer buy" or "what
did we sell last month" without a scan.

### Customers have no names in the UI — LOW

Profile cards show "Assigned" and the replacement dialog shows "Customer 1".
Real names need the Customers module.

### Account-level changes are absent from the timeline — LOW

ADR-006 makes `profile_events` the only event source. A status change or password
edit writes to `audit_logs` but produces no timeline entry, so the account
timeline shows profile activity only.

---

## 4. Operational

### Direct database host is unreachable on IPv4 — INFORMATIONAL

`db.<ref>.supabase.co` publishes only an AAAA record. Use a pooler connection
string. Recorded in `.env.example`.

### Session pooler is in use, not transaction pooler — LOW

Correct for migrations and development. Production should use the transaction
pooler on 6543; `lib/drizzle/client.ts` already sets `prepare: false` for it.

### 4 moderate dev-only advisories — LOW

`drizzle-kit` → deprecated `@esbuild-kit/esm-loader` → vulnerable esbuild. No
upstream fix; `npm audit fix --force` would downgrade drizzle-kit to 0.18.1.
Production audit is clean.

### No automated test suite — MEDIUM

The 55 checks ran through a temporary harness that has been removed. They are
not a permanent gate, and nothing prevents BUG-01 from recurring. **This is the
single highest-value thing to add next** — that bug survived three milestones of
green builds.
