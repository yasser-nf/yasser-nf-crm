# Security Audit

Milestone: M04.8
Date: 2026-08-08
Target: live Supabase project

---

## CRITICAL FINDING — FIXED

### SEC-01 · Every table was world-readable and world-writable

**Severity: CRITICAL. Live in production. Now closed.**

Supabase grants all privileges on public tables to `anon` and `authenticated` by
default. RLS was disabled on all 8 tables and no policies existed.

`anon` is `NEXT_PUBLIC_SUPABASE_ANON_KEY` — shipped in the browser bundle and
readable by anyone who opens devtools.

**Confirmed exploitable before the fix**, not inferred:

```
GET /rest/v1/users      → 200 · name, email, super_admin role
GET /rest/v1/audit_logs → 200 · 3,718 bytes of audit history
```

`INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` were equally available. Any visitor
could have emptied the accounts table.

**Why RLS alone would not have fixed it.** The exposure is the *grant*. RLS
without revoking privileges still permits access when a permissive policy
matches, and a future `GRANT SELECT` would silently reopen everything.

**Fix — migration `0002_rls_lockdown.sql`, two independent layers:**

1. `REVOKE ALL` on tables, sequences and functions from `anon` and
   `authenticated`, plus `ALTER DEFAULT PRIVILEGES` so future tables do not
   reinherit the grants.
2. `ENABLE ROW LEVEL SECURITY` on all 8 tables, with 15 explicit policies.

**Verified after the fix** — the identical requests now return `401` on all
eight tables, and anon `INSERT` is refused.

```
users · audit_logs · accounts · customers
profiles · profile_events · backups · settings   → all 401
```

The application is unaffected: it connects as `postgres`, which carries
`rolbypassrls`. Confirmed post-migration that reads and writes still work and
transactions still roll back cleanly.

---

## Policy Model

Anonymous gets **no policy anywhere** — RLS default-denies, so anon is refused by
omission rather than by a policy someone could later edit to permit.

| Table | Authenticated CRM user | Super Admin |
| ----- | ---------------------- | ----------- |
| `users` | own row only | all, read and write |
| `customers`, `accounts`, `profiles` | read | full |
| `profile_events` | read + insert | read + insert |
| `audit_logs` | insert only | read + insert |
| `backups`, `settings` | none | full |

`profile_events` and `audit_logs` have **no UPDATE or DELETE policy at all**.
That is stronger than a policy returning false: there is nothing to edit,
matching the immutability `01_MASTER_RULES.md` requires.

Role resolution uses `SECURITY DEFINER` helpers with a pinned `search_path` — an
unpinned search path on such a function is a privilege-escalation vector.

**These policies are currently inert**, because the grants they would govern are
revoked. They exist so restoring a grant cannot silently reopen a table — which
is precisely how SEC-01 arose.

---

## Audit Results

### Secrets — PASS

| Check | Result |
| ----- | ------ |
| `.env.local` committed | No — gitignored, only `.env.example` tracked |
| Secrets in source | None |
| Service role key present | Not in the project at all |
| Server-only guards | 6 modules, build-enforced |
| Encryption key validated at boot | Yes, fails fast |
| Placeholder key detected | Yes — encryption refuses to run under it |

### Encryption — PASS

AES-256-GCM, key never enters SQL. Verified at runtime: round trip correct, the
same plaintext yields different ciphertext, and **a tampered ciphertext is
rejected by the auth tag** rather than silently decrypting to garbage.

Passwords are redacted from audit snapshots centrally, verified. PINs are never
written to event metadata, verified.

### Input validation — PASS

Zod at every boundary. Services revalidate rather than trusting the form —
`02_ARCHITECTURE.md` requires validating twice. Query-string values are matched
against known sets before reaching a service. Sort columns resolve through a
lookup table, never string interpolation, so an arbitrary column name cannot
reach SQL.

### Authorization — PARTIAL

Server Actions recheck the session rather than trusting middleware. Account
deletion is refused for everyone because the session carries no role — failing
closed, which is the right direction, but it means the check is untested rather
than working.

**`toAppUser` still does not read `public.users.role`,** even though the column
now exists and holds `super_admin`. Until it does, role-based authorization is
theoretical.

### Service boundaries — PASS

ESLint enforces module barrels, the Drizzle connection boundary, and `no-explicit-any`.
All three were verified with deliberate violations.

### Dependencies — ACCEPTED

0 production vulnerabilities. 4 moderate dev-only advisories via
`drizzle-kit` → deprecated `@esbuild-kit/esm-loader`. No upstream fix exists;
`npm audit fix --force` would downgrade drizzle-kit to 0.18.1.

---

## Outstanding

| Risk | Severity |
| ---- | -------- |
| Audit immutability is convention, not a database grant | MEDIUM |
| `toAppUser` does not read the role, so RBAC is inert | MEDIUM |
| Secrets in snapshots rely on one function, not the type system | MEDIUM |
| Encryption key rotation is unrecoverable, no re-encryption tooling | MEDIUM |
| No rate limiting on Server Actions or login | MEDIUM |
| No security headers (CSP, HSTS) configured | LOW |

---

## The Lesson From SEC-01

This vulnerability existed from the moment the first table was created and
survived M02, M03, M04 and M04.5 — every one of which passed its verification.

It was invisible because every check ran **as the application**, through the
pooler as `postgres`. Nothing ever asked the question an attacker asks: *what
can I reach with the key that ships in the browser?*

Security verification must use the attacker's credentials, not the
application's.
