# Changelog

All notable changes to Yasser NF CRM.

## [Unreleased] — Quick Renew

Named rather than numbered: `CHANGELOG` already uses "M09" for the Dashboard
milestone below, so this is the "M09 Quick Renewing" brief by its title. See
[ADR-015](.ai/adr/ADR-015-Quick-Renew-Decisions.md).

### Added
- **Quick Renew** (`/quick-renew`): find an account by email, pick a profile,
  review the customer and subscription, choose 1/2/3/6 months, 1 year or custom
  days, preview the new expiry, confirm. A live subscription extends from its
  **current expiry**, so renewing early loses no paid day; a lapsed one starts a
  new term today, per `03_DATABASE.md`'s expired-profile rule.
- `RENEW_SUBSCRIPTIONS` permission, held by Super Admin and Worker and enforced
  in the service on all three entry points — including the read-only lookup.
- `addMonths`, `addMonthsToDateString` and `daysBetween` in `lib/dates`.
  Presets are calendar months, clamped at month ends; custom durations are exact
  days. Bounds (1–730) are Quick Prepare's, imported rather than restated.
- Renewals are atomic, idempotent (M08 receipts, scope `quick_renew.confirm`) and
  safe when two operators renew the same profile: the quoted expiry is a
  precondition re-checked under `FOR UPDATE`.
- History as an existing `extended` profile event, so the Reports extensions
  aggregate and the customer timeline pick renewals up unchanged.
- 182 tests: 151 unit (25 of them rendering the screen) and 31 against a real
  database. docs: QUICK_RENEW_MODULE.

### Fixed
- `roleHasPermission` threw on a role the permission matrix does not know, inside
  an authorization check. It now denies. ADR-015 Decision 9.

### Database
- No migration required.

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
