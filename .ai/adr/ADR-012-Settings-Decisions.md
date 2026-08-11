# ADR-012
# Settings And Configuration Decisions

Status: ACCEPTED

Date: 2026-08-11

Owner: Yasser Saidi

Amends: ADR-009

---

# Context

Milestone M11 builds the Settings module and makes it the single source of
configuration.

Three questions had no answer in the documents, and the first was a direct
conflict between the M11 brief and two LOCKED documents. All three were put to
the project owner and approved on 2026-08-11.

---

# Decision 1 — There Is No Theme Setting

## Context

The M11 brief lists "Theme" under General Settings.

01_MASTER_RULES.md (rank 1, LOCKED): "Dark Theme Only. No Light Theme."

04_UI_GUIDELINES.md (LOCKED): "Dark Theme only. No Light Theme. No Theme
Switcher."

## Decision

No theme setting is built. The interface stays dark.

## Why

Two LOCKED documents agree against the brief, and one of them is the highest
authority in the project. 05_DEVELOPMENT_WORKFLOW.md requires stopping and
asking rather than guessing when documents conflict; the owner chose to honour
the locked documents.

A stored-but-inert theme field was also rejected: a control that persists a
preference and changes nothing is worse than an absent one, because it looks
like it works.

## Consequence

Theme is reported as deliberately not delivered, not as an oversight. A unit
test asserts no setting key contains "theme", so adding one back requires
revisiting this decision rather than slipping in.

Building a real switcher later would need an ADR overriding a rank-1 document
and a rework of the token layer, where every colour is currently defined once
for dark only.

---

# Decision 2 — Unenforceable Settings Are Stored And Labelled

## Context

Several settings the M11 brief requires cannot be enforced by this application:

Password policy and session timeout belong to Supabase Auth. ADR-005 Decision 3
made `auth.users` the only credential store and ADR-008 Decision 2 established
that the CRM never sees a password, so it cannot enforce complexity or shorten
a token's lifetime.

Notifications have no delivery mechanism and the `notifications` table is
deferred (ADR-005 Decision 1).

Currency has nothing to format — orders are deferred.

Language has no internationalisation layer.

## Decision

They are stored, validated and audited like any other setting, and every one
carries an explicit enforcement state:

`enforced` — the system acts on it

`external` — recorded here, enforced by a named system

`pending` — stored, awaiting a named piece of machinery

Every surface that shows a setting shows this state and the reason.

## Why

Omitting them would drop most of the Security section and all of Notifications
from the brief. Storing them silently would be worse: a password policy that
looks active but enforces nothing is the kind of thing later mistaken for a
security control, which is a more dangerous outcome than not having the field.

The third option — label them — delivers the configuration surface and tells
the truth about it. Modules can consume the values the moment the machinery
exists.

## Consequence

`Enforcement` is part of the setting definition, not a UI decoration. A test
asserts every non-enforced setting carries a reason, so a new one cannot be
added without stating its status.

---

# Decision 3 — Settings Stay In The Singleton jsonb Column

## Context

The `settings` table holds one row with a `values` jsonb column. Its schema
comment says typed columns are the intended destination and jsonb is a
placeholder. ADR-009 Decision 6 put backup settings in that column and flagged
that promotion should be revisited once settings grew beyond one module.

M11 is that growth: roughly forty settings across six categories.

## Decision

Settings remain in `settings.values`, validated by Zod per category. No
migration, no new table, no new column.

## Why

Forty typed columns on a one-row table would mean a migration for every new
preference, including a change of default. The M11 brief also directs
explicitly: extend the existing table rather than create schema.

Zod gives the same guarantees at the boundary where the value is read and
written, which is the only place it is used — and the boundary is now a single
service rather than scattered call sites, which is what makes that sufficient.

## Consequence

This resolves the note left open in ADR-009 Decision 6. Promotion is not
planned; if a setting ever needs a database-level constraint — a foreign key,
say — that specific setting can be promoted without moving the rest.

`parseConfiguration` never throws, and salvages per category. The jsonb column
is the one place a value can be arbitrary, and a settings page that crashed on
unexpected content would be unusable exactly when it is needed to fix it.

## Note on ownership

The backups category reuses `backupSettingsSchema` from the backups module
rather than restating it. ADR-009 Decision 6 gave that module ownership of its
own configuration shape, and a second definition here would be the duplication
M11 forbids — the two would eventually disagree about a default.

---

# Final Decision

These decisions are adopted. Changing any requires a new ADR and approval from
the project owner.

---

END OF ADR-012
