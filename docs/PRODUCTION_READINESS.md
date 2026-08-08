# Production Readiness

Milestone: M04.8
Date: 2026-08-08

---

## Status Summary

| Dimension | State |
| --------- | ----- |
| Security | RLS closed a critical hole; RBAC still inert |
| Testing | 147 automated tests; authenticated UI uncovered |
| Architecture | Frozen, enforced by ESLint, no violations |
| Data integrity | Verified against the live database |
| Observability | Structured logging only — no monitoring |
| Deployment | Never deployed; no environment exists |

---

## Security Status

**Fixed this milestone:** every table was readable and writable with the
browser-visible anon key. Confirmed exploitable, then closed with `REVOKE` plus
RLS and 15 policies, and re-tested to `401`. See `SECURITY_AUDIT.md`.

**Passing:** encryption with tamper detection, secrets never committed, input
validated twice, server-only guards build-enforced, architecture boundaries
lint-enforced, 0 production vulnerabilities.

**Outstanding:** `toAppUser` does not read `public.users.role`, so role-based
authorization cannot yet pass anyone; audit immutability is convention rather
than a database grant; no rate limiting; no security headers.

---

## Testing Coverage

| Suite | Tests | Runs in CI |
| ----- | ----- | ---------- |
| Unit — phone engine | 43 | yes |
| Unit — allocation engine | 35 | yes |
| Unit — clipboard, Result, errors | 27 | yes |
| E2E — public journeys (×2 projects) | 42 | yes |
| E2E — authenticated journeys | 20 | **skipped** |

**147 passing.** Unit suite runs in 346 ms, so nobody has a reason to skip it.

**What is covered:** every documented phone format and rejection, the allocation
strategy including concentration, all-or-nothing and determinism, expiry maths
across month and year boundaries, the clipboard format byte for byte, the error
hierarchy, protected-route redirects, login validation and failure, dark theme,
responsive layout at three widths, and 44px touch targets.

**What is not covered:** everything behind a login, and every database
interaction. The M04.5 runtime checks verified those once against the live
database but were run through a harness that no longer exists — they are not a
permanent gate.

---

## Architecture Status

Frozen and enforced. Three rules fail the build rather than review:

- Module barrels — deep imports into `@/modules/*/*` are an error
- Connection boundary — only `lib/database` may hold a connection
- `no-explicit-any` — error, not warning

Zero circular dependencies across the source tree. Zero `any`, TODOs or lint
suppressions. Seven ADRs record every decision that deviates from a locked
document.

---

## Known Risks

| Risk | Severity | Mitigation |
| ---- | -------- | ---------- |
| Authenticated UI never exercised | HIGH | Seed a test user |
| RBAC inert — role not read from session | MEDIUM | One change to `toAppUser` |
| No monitoring or alerting | MEDIUM | Not started |
| Rollback SQL never executed | MEDIUM | Test while the database is empty |
| `expiring_soon` / `expired` never written | MEDIUM | Needs a scheduled sweep |
| `health_score` always 100 | MEDIUM | Ranking is effectively by age |
| No orders table | MEDIUM | Blocks all reporting |
| No rate limiting | MEDIUM | Login is brute-forceable |

---

## Technical Debt

- No integration test suite — the M04.5 database checks are gone
- `usersRepository.recordLogin` unreachable; `last_login_at` always null
- Account-level changes produce no timeline entry
- Landlines rejected by the phone engine — mobile-only by design, undocumented until now
- Customers appear as "Customer 1" until the Customers module exists
- `settings.values` is untyped jsonb pending real settings

---

## Deployment Checklist

Nothing has ever been deployed. Before a first deploy:

**Blocking**

- [ ] Sign in once and verify the authenticated UI end to end
- [ ] Wire `toAppUser` to read `role`, then verify a Worker cannot delete
- [ ] Create a **separate production Supabase project** — never share the dev one
- [ ] Generate a **different `ENCRYPTION_KEY`** for production and back it up
- [ ] Use the transaction pooler (6543) for the deployed app
- [ ] Re-run the RLS attack test against production after migrating
- [ ] Confirm `.env.local` is absent from the deployment bundle

**Strongly recommended**

- [ ] Rate limiting on login and Server Actions
- [ ] Security headers: CSP, HSTS, X-Frame-Options
- [ ] Error tracking and uptime monitoring
- [ ] Test the rollback SQL against a scratch database
- [ ] Verify Supabase automated backups are enabled

**Aware**

- [ ] `expiring_soon` / `expired` will never appear without a sweep
- [ ] Reporting is impossible without the orders table
- [ ] Deletion is refused for everyone until RBAC works
