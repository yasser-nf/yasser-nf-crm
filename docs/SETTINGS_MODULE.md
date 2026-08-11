# Settings Module

Version: 1.0
Milestone: M11

Authority: `.ai/` decides, this describes. Decisions in ADR-012.

---

## 1. Responsibilities

| Owns | Does not own |
| ---- | ------------ |
| Every configurable value in the CRM | Any business data |
| Validation, including cross-field rules | The audit log — writes through AuditService |
| Which role may read or change what | The health rule — reused from M09 |
| System measurement (versions, migrations, storage) | The backups config *shape* — owned by the backups module |

**The single source of configuration.** A business module consumes values
through `configurationService`; it never declares a setting, and it never
writes one.

---

## 2. Architecture

```
app/(app)/settings/          layout + 7 routes, composition only
  └── modules/settings (barrel)
        ├── components/
        │     ├── settings-shell.tsx      nav, category grid, search
        │     ├── settings-form.tsx       generated from the catalogue
        │     ├── settings-panels.tsx     search results, system, history
        │     └── category-section.tsx    shared loader for 5 pages
        ├── actions/                      one action: update a category
        ├── services/
        │     ├── settings-definitions.ts the catalogue   (pure, testable)
        │     ├── settings.service.ts     RBAC + audit + persistence
        │     ├── configuration.service.ts how modules read  (read-only)
        │     ├── system.service.ts       measured system information
        │     └── validation.service.ts   cross-field rules (pure, testable)
        ├── repositories/settings.repository.ts
        └── validation/configuration.schema.ts
```

`settings-definitions.ts` is the spine. One declaration per setting drives the
form, the search, the filters, the permissions and the enforcement label — so a
setting cannot exist in one of those and not the others. Same shape as
`report-definitions.ts` in M10.

The form is **generated** from the catalogue rather than hand-written per page.
That is what keeps a settings page free of business logic: it renders what the
catalogue declares and posts it back; every rule about what is valid lives in
the service.

---

## 3. Configuration Flow

```
Business module          Settings page
      │                        │
      │ configurationService   │ settingsService.updateCategory
      │ (read-only, typed)     │
      ▼                        ▼
            settings.values (jsonb, singleton row)
                             │
                    ┌────────┴────────┐
              Zod category schema   cross-field rules
                    └────────┬────────┘
                             ▼
                     audit_logs (before / after)
```

Writes are **one category at a time**. Two people editing different pages must
not overwrite each other's section, and a partial write is the only shape that
makes that true.

Reads never fail. `parseConfiguration` returns a complete, defaulted object from
any input — a module asking for the date format must not break because the
settings read did.

### Storage

ADR-012 Decision 3: everything lives in `settings.values`. **No migration was
added in M11.** Forty typed columns on a one-row table would mean a migration
for every new preference, including a change of default.

The `backup` category reuses `backupSettingsSchema` from the backups module
rather than restating it — ADR-009 Decision 6 gave that module ownership of its
own shape, and a second definition here would be the duplication M11 forbids.
An integration test writes through settings and reads back through
`backupService` to prove they share one definition.

---

## 4. Validation Rules

Two layers, because they answer different questions.

| Layer | Answers |
| ----- | ------- |
| Zod category schema | Is this field valid on its own? |
| `validationService` | Do these fields make sense *together*? |

Cross-field rules currently enforced:

| Rule | Severity |
| ---- | -------- |
| Session timeout longer than the inactive-user threshold | **error** — no session could ever be inactive |
| A schedule enabled with retention keeping nothing | **error** |
| Hourly backups keeping under 24 | warning — under a day of history |
| Lock after 1 failed attempt | warning — locks out anyone who mistypes |
| Locking disabled entirely | warning |
| Notification types on with email delivery off | warning — nothing would send |
| Email notifications on with no company email | warning |

An **error** blocks the save. A **warning** does not — it describes a
combination that is legal but probably unintended, and refusing those would
make the page argue with somebody who knows what they want.

Cross-field rules run against the **merged** configuration, never the fragment
being saved, so a change cannot pass by being judged in isolation.

---

## 5. Enforcement Honesty

ADR-012 Decision 2. Every setting declares whether the system acts on it:

| State | Meaning | Examples |
| ----- | ------- | -------- |
| `enforced` | The system acts on it | application name, backup retention |
| `external` | Recorded here, enforced by a named system | password policy, session timeout — both Supabase Auth |
| `pending` | Stored, awaiting named machinery | every notification switch, the backup scheduler, currency, language |

The label and the reason appear on the form, in search results, and everywhere
else the setting is shown.

This exists because a stored password policy that enforces nothing is the kind
of thing later mistaken for a security control. The CRM never sees a password
(ADR-008 D2), so it *cannot* enforce one — saying so is the only honest option.

A unit test asserts every non-enforced setting carries a reason.

---

## 6. Permissions

| | Super Admin | Worker |
| - | ----------- | ------ |
| General, Company | read + write | **read only** |
| Security, Notifications | read + write | **not visible** |
| Backups | read + write (`ACCESS_BACKUPS`) | **not visible** |
| System | read | **not visible** |
| Change history | read | **no** |

Restricted categories are **removed from the payload**, not hidden in the
markup — a value that never reaches the browser cannot be read out of the HTML.
The integration suite asserts the payload, not the rendering.

Security settings are withheld from Workers specifically because lockout
thresholds and session limits tell an attacker how many attempts they have.

Backups carry `ACCESS_BACKUPS` rather than `ACCESS_SETTINGS`, so changing the
backup policy does not become reachable by widening who can edit settings.

The change history is gated on the **write** permission, not the read one: it
shows old and new values of every setting, including the ones a Worker may not
see in the first place.

---

## 7. Change History

Read from `audit_logs`, never a second table. Every settings write already
records who, when, before and after — exactly what the M11 brief asks the
history to show. A parallel table would record the same fact twice and the two
could disagree.

The audit entry carries **only the category that changed**, not the whole
document. Recording all six would bury the one field that moved in forty that
did not.

---

## 8. System Information

The one settings page with no form. Versions, migration state, environment,
storage usage, scheduler status and health — all measured from the running
system at the moment they are asked for, so nothing there can disagree with
reality.

Health reuses `assessHealth` from M09. The System page, the dashboard light and
the System Health report therefore cannot disagree about what "red" means.

Migration state is read from `drizzle.__drizzle_migrations`, so the page states
which migration the **database** is at rather than which one the source tree
contains.

---

## 9. Extension Points

| Want to | Do |
| ------- | -- |
| Add a setting | Add a definition to the catalogue and a field to its category schema |
| Add a category | Add the key, a schema, a nav entry and a three-line page |
| Add a cross-field rule | One function in `validation.service.ts` |
| Enforce a pending setting | Read it via `configurationService` and change its enforcement to `enforced` |
| Promote one setting to a typed column | Possible per setting without moving the rest — see ADR-012 D3 |

`configurationService.shouldNotify` already exists and nothing calls it. It
settles the rule — channel on **and** type enabled — so that when a sender
arrives the decision is not re-made at each call site.

---

## 10. Tests

| File | Covers |
| ---- | ------ |
| `tests/unit/settings-configuration.test.ts` | 26 cases — catalogue integrity, enforcement labelling, no-theme assertion, parsing resilience, every cross-field rule |
| `tests/integration/settings-module.test.ts` | 19 cases — persistence, per-category isolation, audit entries, RBAC redaction, rejected values not persisted, backups round-trip, system information |

The integration suite captures the real `settings.values` in `beforeAll` and
restores it in `afterAll`, so running it does not change the project's
configuration.

---

## 11. Known Gaps

| Gap | Consequence |
| --- | ----------- |
| No authenticated-browser verification | Screens have never been rendered by a real session; services and route protection are verified |
| Theme is deliberately absent | ADR-012 D1 — reported as not delivered, not as an oversight |
| Logo is a URL, not an upload | Storage exists (the backups bucket), but an upload surface was not built |
| Most Security and all Notification settings are inert | Labelled `external` or `pending`; see §5 |
| Filters are search-only | The brief lists filtering by modified date and modified by; the change history shows both but cannot be filtered on them |
| No settings versioning or rollback | The brief says "version settings changes"; the audit log records every change with before and after, but there is no restore-to-a-previous-version action |
