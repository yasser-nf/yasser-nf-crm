# Production Hardening — M12

Version: 1.0
Date: 2026-08-11

Every claim here is a measurement. Where something was not measured, it says so.

---

## 1. What Was Fixed

| Finding | Severity | Status |
| ------- | -------- | ------ |
| **No security headers at all** — no CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy or Permissions-Policy | **HIGH** | Fixed — `src/lib/security/headers.ts`, applied in `proxy.ts`, verified live |
| No health endpoint; nothing for an uptime monitor to probe | MEDIUM | Fixed — `/api/health`, liveness and readiness, verified live |
| 5 unindexed foreign keys, all pointing at `users` | LOW | Fixed — migration `0010`, re-audited to zero |
| Circular import between `settings` and `backups` barrels | **HIGH** | Fixed in M11 — see ADR-012 D3 |
| Infinite recursion introduced while adding headers | **CRITICAL** | Caught and fixed before commit |

### Security headers, verified live

```
content-security-policy    default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'…
x-frame-options            DENY
x-content-type-options     nosniff
referrer-policy            strict-origin-when-cross-origin
permissions-policy         camera=(), microphone=(), geolocation=(), payment=(), usb=()
strict-transport-security  ABSENT  ← correct in development, by design
```

Applied in `proxy.ts` rather than `next.config.ts` so they cover every response
the proxy produces — pages, redirects, Server Action responses and the export
Route Handler. Twelve unit tests pin the policy, because the failure mode for
headers is a wildcard added to silence a console warning that nobody notices for
a year.

**Known weakening:** `style-src 'unsafe-inline'` is unavoidable — Tailwind and
Next inject inline style attributes and no nonce reaches them. `script-src`
also carries `'unsafe-inline'`, which materially weakens the XSS protection a
CSP is for. Removing it needs nonce plumbing through the RSC render and is the
single largest remaining CSP improvement.

---

## 2. Database Audit — measured

| Check | Result |
| ----- | ------ |
| RLS enabled | **12/12 tables** |
| Policies present | 12/12, 1–3 each |
| Grants to `anon` / `authenticated` | **none** — the M04.8 lockdown holds |
| Unindexed foreign keys | **0** (was 5) |
| Blocked locks | 0 |
| Idle-in-transaction | 0 |
| Longest transaction | 0s |
| Migrations applied | 11, consistent with the journal |

### Not a valid finding: "unused indexes"

The audit reports many indexes with zero scans. At current data volumes that
measures nothing — the tables are empty and the application has barely run.
Reporting them as dead would be a false positive. Re-run this check after a
month of real traffic.

### Dead tuples

Several tables carry more dead than live rows (`backups` 35/16, `customers`
48/0). This is test-suite churn on tiny tables; autovacuum handles it and the
absolute numbers are trivial. Noted so it is not mistaken for a leak.

---

## 3. What Was NOT Verified

This section is the important one.

| Area | Status | Why |
| ---- | ------ | --- |
| **Authenticated UI (Part 9)** | **NOT VERIFIED** | No session reachable from a browser I can drive; I cannot enter a password. Blocked since M06 |
| **Production deployment (Part 11)** | **NOT VERIFIED** | Nothing has ever been deployed. No Vercel project, no `vercel.json`, no production build served |
| **Load and concurrency (Part 10)** | **NOT VERIFIED** | Not executed. Concurrency behaviour is inferred from `SKIP LOCKED` and transaction scoping, not measured |
| **Restore apply path** | **NOT VERIFIED** | Preview, checksum and refusal are verified; applying a restore has never been executed against any database |
| **Behaviour at scale** | **NOT VERIFIED** | Every business table is empty: 0 accounts, 0 profiles, 0 customers, 0 problems |
| Request-level observability (Part 4) | **NOT BUILT** | Correlation IDs, per-request duration and slow-query logging are not implemented |
| Monitoring beyond health (Part 5) | **PARTIAL** | `/api/health` and the System settings page exist; CPU, memory and disk are not collected |
| Rate limiting | **NOT BUILT** | The failed-login endpoint remains unthrottled — flagged since M06 |

---

## 4. Empty Database — the context for every performance claim

Measured row counts: `accounts` 0, `profiles` 0, `customers` 0, `issues` 0,
`users` 2, `audit_logs` 186, `backups` 16.

Every performance number recorded across M09–M11 was taken against this. They
demonstrate that queries are *shaped* correctly — aggregate SQL, no N+1,
bounded pages — but they are not evidence of behaviour at the scale
02_ARCHITECTURE.md targets (100,000 accounts, 500,000 profiles).

Nothing in this project has been tested against production-sized data.

---

## 5. Architecture Review (Part 1)

| Check | Result |
| ----- | ------ |
| Circular imports | One found and fixed (M11, settings ↔ backups). None remaining detected |
| Module boundaries | Enforced mechanically by ESLint `no-restricted-imports`; no violations |
| Repositories exported from barrels | Only `settings` — historical, documented in its barrel |
| `server-only` on every service | Yes, except the deliberately pure modules |
| Route Handlers | Two, both with an ADR (`ADR-011 D3` exports, `ADR-013` health) |
| Dead code | None found by lint; `configurationService.shouldNotify` is unused **by design**, documented |
| ADR coverage | 13 ADRs; every deviation recorded |

### Known architectural debt

- `settings` exports its repository. Justified historically, but it is the one
  barrel that lets a caller bypass a service.
- `allocation.repository.ts` duplicates the blocking-status list because ADR-003
  forbids a repository importing another module. A test pins the copy.
- `CURRENT_MILESTONE.md` still says M02. Stale since M03.
- Journal `when` timestamps for migrations 0007–0010 were hand-written and are
  cosmetically wrong (one reads 2026-08-13). Ordering is correct; only the
  display date is meaningless.

---

## 6. Runtime Hardening (Part 3) — reviewed, partially verified

| Property | State |
| -------- | ----- |
| Result pattern, no thrown business exceptions | Enforced throughout |
| Database error translation + retry with jitter | Implemented; verified since M04.9 |
| Transaction rollback | Verified structurally; restore apply never executed |
| Graceful degradation | Widgets degrade to empty rather than failing the page |
| Suspense boundaries | Present on every list and the dashboard |
| Connection pool exhaustion | **Observed twice in this project**, both times in the test suite. Handled by serialising test files, not by application backpressure |
| Streaming interruption | `pull` is backpressure-aware; interruption not tested |
| Timeouts | Only on the health probe. No global query timeout |
| Graceful shutdown | Not implemented |

---

## 7. Recommended Before v1.0.0

Ordered by what would change a Go/No-Go answer.

1. **Deploy to a staging environment and verify the authenticated UI.** Nothing
   else on this list matters until somebody has used the application.
2. **Execute a restore against a scratch project.** The one destructive path
   that has never run.
3. **Seed production-shaped data and re-measure.** Every performance claim is
   currently against an empty database.
4. **Rate-limit the failed-login endpoint.** Unauthenticated and unthrottled.
5. Rotate the anon key. Outstanding since M04.8.
6. Add request correlation IDs and slow-query logging.
7. Remove `'unsafe-inline'` from `script-src` via nonces.
