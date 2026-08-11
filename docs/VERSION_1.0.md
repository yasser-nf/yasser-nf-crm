# Version 1.0.0 — Production Assessment

Date: 2026-08-11 · Milestone M12

**Verdict: NO-GO for v1.0.0.**

Not because the code is bad. Because the system has never been deployed, never
been used through its own interface by an authenticated person, and has never
held real data. Those are not gaps in polish — they are the entire evidence base
a v1.0.0 claim would rest on.

Recommended: tag **v0.9.0-rc1**, complete the four blockers below, then release.

---

## Scores

Scored against production readiness, not against effort.

| Dimension | Score | Basis |
| --------- | :---: | ----- |
| **Code quality** | **9 / 10** | 512 tests, 7 gates green, strict TypeScript, no `any`, 13 ADRs, every deviation documented |
| **Security (design)** | **8 / 10** | RLS 12/12, no anon grants, headers now set and verified, service key server-only, no password ever handled |
| **Security (operational)** | **4 / 10** | Anon key never rotated after a confirmed exposure. No rate limiting. `script-src 'unsafe-inline'` |
| **Database** | **8 / 10** | All FKs indexed, RLS complete, 11 migrations with verified down scripts. Rollback never executed |
| **Runtime stability** | **5 / 10** | Error model and degradation are sound. **Connection pool exhausted three times today** |
| **Performance** | **3 / 10** | Queries are shaped correctly. Every measurement was against an empty database |
| **Deployment** | **1 / 10** | Never deployed. No Vercel project, no `vercel.json`, no production build served |
| **Observability** | **3 / 10** | Health endpoint and system page exist. No correlation IDs, no slow-query logs, no alerting |
| **Operational readiness** | **3 / 10** | Runbook and incident plan written but never exercised. No on-call, no alerting |
| **Disaster recovery** | **4 / 10** | Backup, checksum and corruption-refusal verified live. **Restore apply never executed** |

**Weighted overall: 4.8 / 10 for production. 9 / 10 as an unreleased codebase.**

---

## Blocking issues

### 1. Connection pool exhaustion — HIGH, and the most likely production outage

Measured today: the `DATABASE_URL` uses Supabase's **session pooler on port
5432, capped at 15 clients**. The application pool is `max: 10` **per instance**.

On Vercel, every serverless instance holds its own pool. Two concurrent
instances exceed the cap. Idle connections were observed lingering for **over
four minutes** before being reclaimed.

This failed three separate times during this session under nothing heavier than
a dev server plus the test suite. Under real traffic it will fail sooner.

**Fix before release:** move to the transaction pooler (port 6543) — which is
what `prepare: false` in the client already anticipates — and/or reduce `max`.
Not changed here because the connection string is your environment and altering
it blind, without load testing, could make things worse.

### 2. Authenticated UI never verified — HIGH

Blocked since M06. No session is reachable from a browser I can drive and I
cannot enter a password. Every screen across Dashboard, Reports, Settings,
Problems, Backups, Users, Customers, Accounts and Quick Prepare has been
verified only at the service layer.

Route protection (307 → `/login`) and RBAC are verified. Rendering, forms,
dialogs, toasts, empty states, responsive layout and accessibility are not.

### 3. Restore apply never executed — HIGH

Preview, checksum verification and corruption refusal are all verified live. The
one path that writes — applying a restore — has never run against any database.

It is the single most destructive operation in the system, and the only claim
about it is that the code reads correctly.

### 4. Never deployed — HIGH

No Vercel project exists. The production build has never been served, the
security headers have never been observed over HTTPS, HSTS has never been
emitted, and no migration has run against a production database.

---

## Non-blocking but real

| Issue | Severity |
| ----- | -------- |
| Anon key never rotated after the M04.8 exposure | MEDIUM |
| No rate limiting; the failed-login endpoint is unauthenticated and unthrottled | MEDIUM |
| Every performance figure measured against 0 accounts, 0 customers, 0 profiles | MEDIUM |
| `script-src 'unsafe-inline'` materially weakens the CSP | MEDIUM |
| Backup scheduler stores a schedule nothing fires (ADR-009 D2) | MEDIUM |
| No alerting, no log aggregation, no correlation IDs | MEDIUM |
| Orders deferred — no revenue anywhere in the system | LOW (scoped out) |
| `CURRENT_MILESTONE.md` stale since M03 | LOW |

---

## What is genuinely strong

Worth stating plainly, because the scores above are harsh by design.

- **Security architecture.** RLS on every table with no grants to `anon` — and
  that lockdown was written *after* finding a confirmed, exploitable hole, then
  re-tested from the attacker's position. Regression tests keep it closed.
- **The CRM never handles a password.** Not by policy — by construction. There
  is no field, no parameter, no column.
- **Every destructive path refuses first.** Last-Super-Admin, self-lockout,
  session ownership, illegal transitions, checksum mismatch. All verified live.
- **The audit trail is real.** Immutable, never deleted, and the settings and
  problem histories are derived from it rather than duplicated.
- **Documented reasoning.** 13 ADRs, and every conflict between the briefs and
  the locked documents was stopped on and asked about rather than guessed.

---

## Path to v1.0.0

1. Switch to the transaction pooler; load test; confirm no exhaustion.
2. Deploy to staging. Walk every screen signed in as Super Admin, then as Worker.
3. Restore drill against a scratch project.
4. Seed production-shaped data; re-measure the dashboard, reports and exports.
5. Rotate the anon key.
6. Rate-limit authentication.

Items 1–4 are the ones that would change this verdict. Until they are done,
v1.0.0 would be a claim about code that has never met production.
