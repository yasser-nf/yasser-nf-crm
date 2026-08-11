# Release Checklist — v1.0.0

Version: 1.0 · Milestone M12

Tick nothing that has not actually been done.

---

## Automated gates

- [x] `npm run verify` green — lint, typecheck, format, db:check, test, build, audit
- [x] Tests passing (512)
- [x] 0 production vulnerabilities
- [x] Every migration has a verified down script

## Security

- [x] RLS enabled on 12/12 tables, policies present
- [x] No grants to `anon` or `authenticated`
- [x] Security headers set and verified live
- [x] Service role key server-only, never in client config
- [x] No password ever handled by the CRM
- [ ] **Anon key rotated after the M04.8 exposure** — outstanding
- [ ] **Rate limiting on the failed-login endpoint** — not built
- [ ] `script-src 'unsafe-inline'` removed via nonces

## Database

- [x] All foreign keys indexed
- [x] Migrations consistent with the journal
- [ ] **Rollback executed against a real database** — never performed
- [ ] **Production-shaped data loaded and re-measured** — every table is empty

## Disaster recovery

- [x] Backup creation verified live
- [x] Checksum verification verified live
- [x] Corrupted backup refused, verified live
- [x] Restore preview verified live
- [ ] **Restore apply executed** — never performed
- [ ] Scratch-project restore drill

## Application

- [x] Route protection verified on every route (307 → /login)
- [x] RBAC verified at the service layer for every module
- [x] Health endpoint live
- [ ] **Authenticated UI verified in a browser** — blocked since M06
- [ ] Load and concurrency testing
- [ ] Accessibility audit

## Deployment

- [ ] **Vercel project created**
- [ ] **Deployed once**
- [ ] Production build served and probed
- [ ] Custom domain and TLS
- [ ] Backup scheduler trigger (ADR-009 D2)

## Verdict

Automated quality is high. **Operational readiness is unproven** — the
application has never been deployed, never been used through its own UI by an
authenticated person, and never held real data.

See `VERSION_1.0.md` for the Go/No-Go.
