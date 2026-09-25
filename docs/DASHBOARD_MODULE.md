# Dashboard Module

Version: 1.0
Milestone: M09

Authority: `.ai/` decides, this describes.

---

## 1. Responsibilities

| Owns | Does not own |
| ---- | ------------ |
| Aggregating the operational picture | Any data — every table belongs to another module |
| The system-health rule | Allocation — that is `evaluateAllocation` |
| Deciding which metrics a role may see | Presence — that is `usersService` |
| Chart rendering | Problem state — that is `problemsService` |

**This module owns no data.** It reads counts the other modules have no reason
to expose, and borrows everything with a rule attached through their public
APIs. Nothing on the page is stored, cached or precomputed, so no figure here
can disagree with the data it describes.

---

## 2. Architecture

```
app/(app)/dashboard/page.tsx        composition + Suspense boundaries
  └── modules/dashboard (barrel)
        ├── components/
        │     ├── dashboard-primitives.tsx   Widget, Metric, BarChart, empty states
        │     └── dashboard-widgets.tsx      the sixteen widgets
        ├── services/
        │     ├── dashboard.service.ts       assembly + RBAC
        │     └── system-health.ts           the health rule (pure, testable)
        └── repositories/
              └── dashboard.repository.ts    aggregate SQL
```

Every component is a **Server Component**. Widgets receive numbers that are
already computed, so none of them need state or effects and the page ships as
HTML with no client JavaScript for its data.

The repository is not exported from the barrel. It can count every row in the
system, and exposing it would offer a way past the role check that decides which
of those counts a caller may see.

---

## 3. Widgets

| Widget | Source | Visible to |
| ------ | ------ | ---------- |
| Accounts | aggregate over `accounts` + `issues` | everyone |
| Profiles | aggregate over `profiles` | everyone |
| Customers | aggregate over `customers` | everyone |
| Problems (counts) | aggregate over `issues` | everyone |
| Quick Prepare | `profile_events` where `event_type = 'sold'` | everyone |
| Expirations | `profiles.expiration_date` | everyone |
| Revenue | **nothing — states the gap** | everyone |
| Newest / Critical / Waiting longest / Assigned to me | `problemsService.list` | everyone |
| Reopened | `issues.reopen_count > 0` | everyone |
| Smart stock | `evaluateAllocation` | `VIEW_ACCOUNTS` |
| Recent activity | `audit_logs` ∪ `profile_events` ∪ `login_history` | admin (Workers get profile events only) |
| System health | computed | Super Admin |
| Backups | aggregate over `backups` | Super Admin |
| Users | aggregate over `users` | Super Admin |
| Who's online | `usersService.onlineNow` | Super Admin |
| Charts | series queries | Super Admin sees the backups chart |

### Revenue

Orders do not exist — ADR-005 Decision 1 deferred the table and nothing records
money. The widget says **"Orders module not implemented."** rather than showing
a zero, because a zero reads as "no sales" instead of "not built". The M09 brief
is explicit: do not invent revenue.

### Expirations

Read from `expiration_date` directly, never from `profiles.status`. ADR-005
records that `expiring_soon` and `expired` are stored enum values nothing
currently writes — trusting them here would report zero forever.

### Smart stock

Availability is counted by running each profile through `evaluateAllocation`,
the same function Quick Prepare uses. Not tidiness: a second definition of
"allocatable" on the dashboard would eventually disagree with the one that
actually allocates, and the widget would advertise stock the engine refuses.
Problem accounts drop out automatically, because that rule now lives inside
`evaluateAllocation` too.

---

## 4. System Health

Green · Yellow · Red, computed in `system-health.ts` from measured facts.

| Finding | Level |
| ------- | ----- |
| Database unreachable | red, and nothing else is reported |
| Any critical problem open | red |
| No backup has ever completed | red |
| Last backup ≥ 48h old | red |
| Last backup ≥ 24h old | yellow |
| Any failed backup | yellow |
| Latest backup unverified | yellow |
| Everything passed | green |

**Worst wins.** A green finding never offsets a red one — averaging severities
would let three healthy checks hide a failing backup, which is the opposite of
what a status light is for.

Never hardcoded. The rule is pure and unit tested, including a case asserting it
can never report green while any finding is not green.

---

## 5. Permissions

Two tiers, decided once in `canSeeAdminMetrics` rather than per widget:

| | Super Admin | Worker |
| - | ----------- | ------ |
| Accounts, profiles, customers, problems, Quick Prepare, expirations | yes | yes |
| Smart stock | yes | yes (`VIEW_ACCOUNTS`) |
| Problem lists | yes | yes — visibility is global (ADR-010 D5) |
| Users, backups, health, who's online | yes | **no** |
| Activity feed | all three sources | profile events only |

Administrative metrics are **omitted from the payload**, not hidden in the
markup. A Worker's response contains `null` for backups, health and online
users — a number that never reaches the browser cannot be read out of the HTML.

The integration suite asserts exactly that, rather than checking what renders.

---

## 6. Performance

The M09 rule: the dashboard must not run fifty independent queries.

| Concern | Approach |
| ------- | -------- |
| KPI counts | **Six statements**, each using `filter (where …)` so every bucket is counted in one pass over the table. Adding a KPI costs no extra round trip |
| Parallelism | Every read in `load` runs in `Promise.all` — the page is as slow as the slowest read, not their sum |
| Activity feed | One SQL `UNION ALL`, ordered before the limit. Merging three limited lists in JavaScript would drop entries that belong on the page |
| Stock | One query returning accounts with their profiles, grouped in memory. A profile query per account is the N+1 the brief forbids |
| Charts | `generate_series` zero-fills, so a gap renders as zero rather than a missing point implying activity |
| Suspense | Three boundaries — counts, stock and activity stream independently rather than the page waiting on the slowest |

Measured against the live Supabase project: a full `load()` returns in roughly
**0.4s** warm. The integration test budget is deliberately looser (10s), because
these runs cross the public internet where one round trip already costs
hundreds of milliseconds — what it actually guards is the fifty-query failure
mode, which shows up as seconds.

---

## 7. Charts

Hand-rolled inline SVG. No charting library was added: 01_MASTER_RULES.md
prefers native APIs and warns against unnecessary packages, and a bar chart is a
handful of rectangles. A library would have added bundle weight and forced a
client component where a server-rendered SVG does the job.

Charts render an **empty state when every value is zero** — a flat line at zero
looks like a broken chart rather than an empty one.

---

## 8. States

Every widget defines all five the brief requires:

| State | Where |
| ----- | ----- |
| Loading | `Skeleton` in the page's Suspense fallbacks |
| Empty | `WidgetEmpty` |
| No data | same component, per-widget message |
| Error | `WidgetError`, distinct from empty |
| Permission denied | `WidgetForbidden` |

Empty and error are deliberately different components. "No data yet" is a normal
state for a CRM that has not been filled in, and dressing it as a failure would
send somebody hunting a bug that is not there.

---

## 9. Tests

| File | Covers |
| ---- | ------ |
| `tests/unit/system-health.test.ts` | 10 cases — every level, escalation by backup age, worst-wins |
| `tests/integration/dashboard-module.test.ts` | 17 cases — live aggregates, RBAC split, stock reuse, pagination, performance |

Two integration cases are worth calling out. One cross-checks a dashboard bucket
against an independent `count(*)` — the aggregate SQL is hand-written and
TypeScript cannot check it, so a `filter (where …)` with the wrong predicate
would otherwise return a plausible number forever. The other asserts **every
repository read succeeds**, because the service degrades a failed widget read to
an empty list, which is right for the page and would otherwise hide a broken
query permanently.

---

## 10. Known Gaps

| Gap | Consequence |
| --- | ----------- |
| No authenticated-browser verification | The page has never been rendered by a real session; route protection and the services are verified, the visual result is not |
| Most charts are empty | The database currently holds 0 accounts and 0 customers, so the series are real but flat |
| Activity feed is not infinite-scroll | It paginates via the service, but the page renders the first 20; wiring the scroll needs a client component |
| Revenue is a placeholder | By design, until orders exist |
| `04_SECURITY.md` does not exist | The M09 brief names it; the actual rank-5 document is `04_UI_GUIDELINES.md`, which is what this module followed |

---

## 11. M04 — every figure from the application's own rules

### Audit (before → after)

| Metric | Was | Problem | Now |
| ------ | --- | ------- | --- |
| Accounts: Healthy | `accountMatchesStatusSql('healthy')` | right since M03, but no Expired bucket beside it | `accountEffectiveStatus` → healthy (= `accountCanAllocate`) |
| Accounts: With problems | distinct live accounts with a blocking issue | an archived account with a problem was also Archived; a fault stored on the account counted nowhere | **Problems** = effective status is a fault (blocking problem, or fault recorded on the account) |
| Accounts: Expired | — | missing | effective status `expired` |
| Accounts: Archived | `status = 'archived'` | could overlap With problems | effective status `archived` |
| Profiles | `profileCellState` tally (M01.5) + stored `reserved` | Reserved never written and already inside Sold; Blocked and Not for sale not shown, so the card did not add up | six `profileCellState` states shown, summing to Total; Reserved removed |
| Expirations | SQL on `expiration_date` with `current_date` | cumulative, overlapping windows; free slots counted; database time zone | disjoint UTC-day buckets over held allocations, from the same classification |
| Problems | open / waiting / in progress / resolved today / critical over ALL issues | included problems on deleted accounts; no records-vs-accounts distinction | live accounts only; **Blocking** (records) + accounts affected; payment problems (records + accounts) |
| Smart stock | `stockCandidates(25)` via `to_jsonb` | snake_case keys → every profile judged "not for sale" → **no stock ever shown**; only the 25 oldest accounts | total = `quickPrepareService.availableStock()`; breakdown via the query builder (camelCase, no credential) |
| Sales (Quick Prepare) | `date_trunc(…, now())` | session time zone | `date_trunc(…, now(), 'UTC')` |
| Charts: accounts / customers / backups per day | session-time-zone days | — | UTC days |
| Chart: problems by severity | blocking problems, all accounts | severity is no longer asked for (M03) | kept, retitled "by stored severity", live accounts only, with the reason stated |
| Chart: problems by type | — | — | new: blocking problems on live accounts by type |
| Failed reads | charts, lists and "who's online" became `[]` / forbidden | an outage looked like "no data" or "not your role" | `null` / `"error"` → an explicit error in the widget; "Online" shows "—" |

### Definitions

**Accounts** (live = not soft-deleted): `Healthy + Problems + Expired + Archived = Total`, disjoint, one bucket per account from `accountEffectiveStatus` (`services/account-state-counts.ts`). Blocking problem types come from `problemsService.accountsWithActiveProblems` — the call the Accounts list makes. *Documented exception:* an archived account with an open problem is Archived (M03 precedence: the stored status names it first, as its badge does); it is still in the Problems widget's "accounts affected".

**Profiles**: `Available + Sold + Expiring soon + Expired + Blocked + Not for sale = Total`, one `profileCellState` state each. Available = free and sellable now; free slots on an account that cannot sell (problem, fault, expired validity) are Blocked.

**Stock** = Quick Prepare's `availableStock()` = `Available + resellable expired`. The one legitimate difference from the profile buckets is the recycling rule (03_DATABASE: an expired allocation on a healthy account is available again): those profiles show as Expired, and are also stock. The Profiles card says how many.

**Expirations**: `Today + Tomorrow + In 2–3 days = Expiring soon` (EXPIRING_SOON_DAYS = 3) and `Already expired = Expired`. Held allocations only.

**Problems**: records vs accounts are separate numbers (one account with three problems = 3 blocking, 1 affected). Live accounts only — so the dashboard can show fewer than the Problems page while a problem remains open on a deleted account (reported in M03).

### Dates

All day boundaries are UTC: TypeScript through `remainingDays` (UTC dates), SQL through the three-argument `date_trunc(field, ts, 'UTC')` and `(now() at time zone 'UTC')::date`. An integration test sets the session to UTC+14 and requires identical figures. Shared allocation predicates elsewhere still use `current_date` (production's database is UTC); out of M04 scope.

### Refresh

The page reads the session cookie, so it is rendered per request; every navigation or `router.refresh()` shows current data. Mutations already revalidate their paths; no polling, no background job.

### Performance

`counts()` — 4 aggregate statements; plus one read of live accounts (4 columns), one of their blocking problem types, one of live profiles with account facts, and the list/chart reads — all in parallel. Classification of a few hundred rows happens on the server; nothing reaches the browser but finished numbers.

