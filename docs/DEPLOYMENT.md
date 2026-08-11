# Deployment

Version: 1.0 · Milestone M12

**Nothing has ever been deployed.** This document is the intended procedure, not
a record of one that has been performed. Every step is unverified.

---

## 1. Prerequisites

| Requirement | State |
| ----------- | ----- |
| Supabase project | Exists, in use for development |
| Vercel project | **Does not exist** |
| `vercel.json` | **Absent** — defaults apply |
| Custom domain | Not configured |
| Anon key rotated after the M04.8 exposure | **No** — outstanding |

## 2. Environment variables

Required, validated at boot by `config/env.ts` and `config/env.server.ts` —
the build fails fast if any is missing or malformed.

| Variable | Scope | Notes |
| -------- | ----- | ----- |
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | Also used to build the CSP `connect-src` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client + server | Ships in the browser bundle by design |
| `DATABASE_URL` | server | Session pooler, IPv4 |
| `ENCRYPTION_KEY` | server | 64 hex chars. **Losing it makes every stored account password unrecoverable** |
| `SUPABASE_SERVICE_ROLE_KEY` | server | Bypasses RLS. Invitations and backup storage only |

`ENCRYPTION_KEY` and `SUPABASE_SERVICE_ROLE_KEY` must never be added to
`config/env.ts` — that file is client-reachable. Both live in `env.server.ts`,
which imports `server-only`.

## 3. Procedure

1. Create the Vercel project, link the repository, set every variable above.
2. Run migrations against production: `npm run db:migrate`. Migrations are not
   run automatically at build — deliberately, so a schema change is a decision.
3. Deploy. `npm run build` runs typecheck and fails the deploy on error.
4. Probe `/api/health` — expect `200` with `checks.database.status = "ok"`.
5. Sign in and walk the checklist in `RELEASE_CHECKLIST.md`.

## 4. Post-deploy verification

```
GET /api/health?probe=liveness   → 200, no database dependency
GET /api/health                  → 200 ok | 503 degraded
GET /login                       → 200, security headers present
GET /dashboard  (no session)     → 307 to /login
```

Confirm `strict-transport-security` **is** present in production — it is
deliberately suppressed in development.

## 5. Rollback

Application: redeploy the previous Vercel build.

Database: apply the matching file from `drizzle/down/`. Every migration has a
verified down script. **No rollback has ever been executed against a real
database** — the down migrations are reviewed, not exercised.

## 6. Not configured

Cron (the backup scheduler has no trigger — ADR-009 D2), custom cache headers,
compression beyond Vercel defaults, WAF, alerting, log drains.
