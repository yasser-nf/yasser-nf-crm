# Changelog

All notable changes to Yasser NF CRM.

## [0.9.0-rc1] — 2026-08-11 — M12 Production Hardening

### Added
- Security headers on every response: CSP, HSTS (production only), X-Frame-Options,
  nosniff, Referrer-Policy, Permissions-Policy. Verified live. 12 unit tests.
- `/api/health` — unauthenticated liveness and readiness probes with a 2s database budget.
- Indexes on all five previously unindexed foreign keys (migration 0010).
- `scripts/production-audit.mjs`, `scripts/pool-status.mjs` — read-only diagnostics.
- docs: PRODUCTION_HARDENING, DEPLOYMENT, RUNBOOK, INCIDENT_RESPONSE,
  RELEASE_CHECKLIST, VERSION_1.0.

### Fixed
- Infinite recursion introduced while wiring the header helper, caught before commit.

### Known blockers for 1.0.0
- Session pooler capped at 15 clients against a per-instance pool of 10.
- Authenticated UI never verified in a browser.
- Restore apply path never executed.
- Never deployed.

## [0.8.0] — M11 Settings
Single source of configuration. Six categories, ~40 settings, no migration.
Fixed a circular import between settings and backups.

## [0.7.0] — M10 Reports & Export
Ten reports, CSV/Excel/PDF, streaming Route Handler, saved presets.

## [0.6.0] — M09 Dashboard
Sixteen widgets, computed system health, RBAC-filtered payloads.

## [0.5.0] — M08 Problems
Single source of truth for account problems; allocation coupling.

## [0.4.0] — M07 Backups
Backup, restore preview, checksum integrity, retention.

## [0.3.0] — M06 Users
Invitation workflow, sessions, presence, login history.

## [0.2.0] — M03–M05
Accounts, Profiles, Quick Prepare, Customers.

## [0.1.0] — M01–M02
Foundation, authentication, database, RLS lockdown.
