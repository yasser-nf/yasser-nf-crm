# Known Limitations

As of M04.5. Everything here is a deliberate, recorded gap — not something
waiting to be discovered.

---

## 1. Security

### RLS guards the perimeter, not application queries — MEDIUM

*Updated in M01.5. This entry previously read "RLS is not enabled on any table —
HIGH", which stopped being true with migration 0002.*

Migration 0002 enabled Row Level Security and revoked every privilege from
`anon` and `authenticated`. Verified against production in M01: all twelve
tables have `relrowsecurity = true`, and no grant to either role remains. The
anon key no longer reaches table data through PostgREST.

What remains is the half that was always true: the application connects as
`postgres`, which has `rolbypassrls = true`, so RLS is never consulted for the
application's own queries. Authorization for those lives entirely in the service
layer. A service method that forgets its permission check has no database-level
backstop.

### Audit immutability is convention, not enforcement — MEDIUM

No update or delete method exists for `audit_logs`, and none should. But nothing
at the database level prevents one. A `REVOKE UPDATE, DELETE` on the application
role would make it structural; that needs a decision about which role the app
connects as.

### Secrets in snapshots rely on one function — MEDIUM

*Updated in M01.5.* The function was not enough: it stripped three field names
at the top level only, and customer profile PINs were written into
`audit_logs` in plaintext (M01 finding F8 — 249 rows by M01.5).

`auditService` now applies `sanitizeAuditSnapshot` (audit-redaction.ts): a
per-entity allow-list of fields, then redaction of sensitive keys at every
depth. Migration 0013 redacts the historical PINs; **it must be applied to
production after the code is deployed** (see the M01.5 report).

Still true: a caller writing directly to `auditRepository` bypasses it — it
remains convention, enforced in one place rather than by the type system.
`profile_events.metadata` is outside it too; verified safe today (a PIN change
records only `hadPreviousPin`). Backup artifacts taken before 0013 still contain
the PINs, and restoring one would write them back.

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

### Direct user creation has not run against real Supabase Auth — MEDIUM

*Added in M02.* `usersService.create` (ADR-014) is tested against the isolated
database with a stand-in for `auth.admin.createUser` and `deleteUser` that
writes the `auth.users` shim. That proves both rows are written or neither, the
audit entry, and that getCurrentUser accepts the new user. It cannot prove that
Supabase accepts a password sign-in for the new identity, or that
`deleteUser` compensation succeeds against the real API: there is no GoTrue
locally, and doing it in production creates a real user. One creation and
sign-in should be verified after deployment, with the owner's approval.

---

## 3. Functional Gaps

### ~~`users.last_login_at` is never written~~ — RESOLVED

*Updated in M01.5.* No longer true: the column is written on sign-in
(`src/lib/auth/session.ts`) and by `usersRepository.recordLogin`. The Users page
"Last login" column reflects it.

### Account deletion is refused for everyone — MEDIUM

`assertMayDelete` fails closed because the signed-in `AppUser` carries no role.
`public.users.role` now exists and holds `super_admin`, so the deferral in
ADR-005 can be lifted — but `toAppUser` does not read it yet. Archive is
unaffected.

### `expiring_soon` and `expired` are never set — MEDIUM

Both enum values exist and nothing writes them. They are functions of
`expiration_date` and today's date, and the scheduled sweep that would apply
them does not exist. A subscription that has ended still reads as `sold` in the
`profiles.status` column.

*Updated in M01.5:* still true in the database, but nothing user-visible trusts
the column any more. Every profile badge derives its state from
`expiration_date` through `profileCellState`, and since M01.5 so do the
Dashboard's profile counts, which used to read these never-written values and
showed 0 expired while six had expired (M01 finding F5). `reserved` is likewise
never written.

### `health_score` column is orphaned — LOW

*Updated in M01.5. This entry previously read "`health_score` is always 100 —
MEDIUM".* The Health system has since been removed from the application; nothing
reads or writes the score.

The physical column and its `accounts_health_score_range` check still exist in
the database (verified in M01.5) — dropping them is a deliberate, destructive
decision that has not been taken. The TypeScript schema no longer declares the
column, so `drizzle-kit generate` will not propose dropping it on its own.

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

### ~~No automated test suite~~ — RESOLVED, with one caveat

*Updated in M01.5.* No longer true: a Vitest suite of unit tests (`npm test`) and
24 integration files runs on every change.

The caveat was serious and M01.5 addressed it: until then the integration files
ran against the PRODUCTION database — 21 of 24 write rows — and their results
depended on live stock. They now run only through `npm run test:integration`,
against an in-process PostgreSQL with every migration applied and a fixed seed.
`npm test` skips them. A guard refuses any target that is the production
project.
