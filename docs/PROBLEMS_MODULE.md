# Problems Module

Version: 1.0
Milestone: M08

Authority: `.ai/` decides, this describes. Decisions in ADR-010.

---

## 1. Responsibilities

| Owns | Does not own |
| ---- | ------------ |
| Every account problem, start to finish | `accounts.status` — that stays operational state |
| The transition graph | Allocation itself — Quick Prepare still decides that |
| Assignment and ownership | User identity — resolved through the Users module |
| Internal notes | The audit log — written through AuditService |
| The derived timeline | Profile state |

**The single source of truth.** No module creates or resolves a problem
directly. That is why the repository is not exported from the barrel: a caller
holding it could write an `issues` row with no transition check, no audit entry
and no permission check — and those three are what make this a source of truth
rather than a table with a screen attached.

---

## 2. Architecture

```
app/(app)/problems/*            page composition only
  └── modules/problems (barrel)
        ├── components/         client rendering
        ├── actions/            network boundary (ADR-006 D3)
        ├── services/
        │     ├── problems.service.ts             report, list, update, delete
        │     ├── problem-assignment.service.ts   assign · claim · unassign
        │     ├── problem-resolution.service.ts   resolve · reopen · close · cancel
        │     ├── problem-timeline.service.ts     derived timeline + notes
        │     └── problem-lifecycle.ts            the graph  (pure, testable)
        ├── repositories/       problems.repository.ts
        └── validation/         Zod schemas
```

`problem-lifecycle.ts` carries no `server-only` import, which is what makes the
transition graph unit testable — the same split as `presence.ts` (M06) and
`retention.ts` (M07).

Four services rather than one because they carry different risks. Resolution and
reopening have consequences beyond the status column, so `problemsService.update`
deliberately **refuses** those two transitions and points at
`ProblemResolutionService`. The resolution note and the reopen counter each have
exactly one code path.

---

## 3. Lifecycle

```
                 ┌──────────────► cancelled  (terminal)
                 │                    │
                 │                    └─► closed   (Super Admin only)
                 │
   open ──► in_progress ──► waiting
     │           │             │
     └───────────┴─────────────┴──────► resolved ──► closed
                                            │           │
                                            └── open ◄──┘   (reopen, +1)
```

| Rule | Why |
| ---- | --- |
| `in_progress` never returns to `open` | Work that started stays started; sliding back loses the fact somebody looked |
| Nothing reaches `closed` without `resolved` | Closing directly would bypass the mandatory resolution note |
| `cancelled` is terminal | It means the problem should never have been raised — there is nothing to resume |
| Only a Super Admin closes a cancelled problem | The M08 brief says Workers may not, which implies somebody can |

Enforced in `problem-lifecycle.ts` and nowhere else. The detail screen builds its
buttons from the same `allowedTransitions` the service checks, so the UI cannot
offer a move the server rejects.

### Severity and description — stored, no longer asked for (M03)

`low` · `medium` · `high` · `critical`. Workers may not change it.

Since M03 neither severity nor a free-text description is asked for when a
problem is reported, and neither is shown on the Problems list, the problem
detail, the account page, Quick Replace or the customer page. The workflow acts
on the **account** and the **problem type**; nothing acted on the other two.

Both columns stay. Every earlier problem carries them and the timeline reads
them. A report without them is stored with the column default `medium` and an
empty description (`issues.description` is NOT NULL; an empty string says
truthfully that nobody described it). A caller that still sends either is still
validated. The dashboard's severity chart is unchanged (M03 does not touch the
dashboard).

### Blocking, on screen

Every list row and the detail screen say whether a problem is **blocking**,
from `isBlocking` — never restated. The list has a **Blocking now** filter
(`open`, `in_progress`, `waiting`) and links each row to its account. The
detail screen's notice that all five profiles are blocked appears only while
the problem is blocking; the stored account status, which reads `healthy`
beside an open problem, is no longer shown as if it were the account's state.

An account whose blocking problems are all of one type shows that type on its
badge (e.g. **Payment Problem**), matching the Payment Problem filter
(`accountMatchesStatusSql`); several types show **Problem**.

### Problem types

`payment_problem` · `incorrect_password` · `invalid_email` ·
`something_went_wrong` · `other` — 03_DATABASE.md's Issue Type list, verbatim.

---

## 4. Grain — problems belong to accounts

03_DATABASE.md: **"Issues belong to Accounts. Never Profiles."**

Affected profiles are **derived**. An unhealthy account makes all five profiles
unavailable, which is already the documented business rule, so "affected
profiles" is exactly that set — a computed fact, not a stored relationship.

Reporting from a profile raises the problem on that profile's account. See
ADR-010 Decision 2 for why a join table was rejected.

---

## 5. Assignment Flow

```
unassigned ──claim──►  worker owns it  ──release──►  unassigned
                             │
                    Super Admin may reassign to anyone, at any time
```

| Actor | May |
| ----- | --- |
| Super Admin | assign anything to anyone |
| Worker, problem unowned | claim it for themselves |
| Worker, problem theirs | release it |
| Worker, problem owned by someone else | nothing |

A closed or cancelled problem cannot be assigned — a live assignment on work
nobody is going to do is noise.

Assignment history is **not** a table. Every change writes an audit entry with
before and after, and the timeline reads them back.

---

## 6. Resolution Flow

```
resolve  →  requires a note (≥10 chars), records resolved_by and resolved_at
reopen   →  requires a reason, increments reopen_count,
            CLEARS the stale resolution, appends the reason as a note
close    →  from resolved (or cancelled, Super Admin only)
cancel   →  terminal
```

The resolution note is enforced **twice**: by the Zod schema in the service and
by a check constraint on the table. Two layers because a "resolved" nobody
explained is indistinguishable from one nobody fixed, and the next person to hit
the same fault learns nothing.

Reopening clears `resolution_note`, `resolved_at` and `resolved_by`. Keeping them
would leave the row claiming a resolution that demonstrably did not hold — and
the old note survives in the audit trail, which is where history belongs.

`reopen_count` exists because a fault that keeps returning is a different signal
from one that happened once, and that is only visible if returns are counted
rather than re-dated.

---

## 7. Timeline

**Derived, not stored.** Two sources, no third table:

| Source | Provides |
| ------ | -------- |
| `audit_logs` where `entity = 'issue'` | created, assigned, reassigned, severity changed, status changed, resolved, closed, cancelled, reopened |
| `issue_notes` | comments |

The timeline service translates each audit diff into a sentence. Every event it
shows is already implied by a diff recorded for other reasons, so writing a
parallel history would double every write and create two records that can
disagree — see ADR-010 Decision 3.

Notes are append-only. There is no edit and no delete anywhere in the module, and
the table has no `updated_at` at all: a note that can change is not a record of
what somebody said at the time.

The timeline is loaded **only** when a detail page opens. Nothing in the list
touches it.

---

## 8. Permissions

| | Super Admin | Worker |
| - | ----------- | ------ |
| Report a problem | yes | **yes** |
| See the list and every detail | yes | **yes** — visibility is global |
| Update / resolve | any | only problems assigned to them |
| Add notes | any | only problems assigned to them |
| Claim an unassigned problem | yes | yes |
| Reassign someone else's | yes | no |
| Change severity | yes | **no** |
| Delete | yes | **no** |
| Close a cancelled problem | yes | **no** |

Three permissions carry this: `REPORT_PROBLEMS` and `VIEW_PROBLEMS` are granted
to Workers; `MANAGE_PROBLEMS` is Super Admin only. Ownership depends on the row,
so it cannot be a permission — `assertMayMutate` checks it in the service.

Every check is server-side. A Server Action is a POST endpoint anyone holding a
session can call, so a hidden button protects nothing.

---

## 9. Integrations

| Module | What happens |
| ------ | ------------ |
| **Accounts** | Detail reads active problems through `problemsService`, never by querying `issues`. `evaluateAllocation` gains the second input and a new `account_has_problem` reason |
| **Quick Prepare** | Eligibility query gains a `NOT EXISTS` clause, so a blocked account is never offered — and never locked |
| **Customers** | Customer detail lists active problems on the accounts they hold profiles on |
| **Users** | Assignee, reporter and resolver resolve through the Users module's public API |
| **Audit** | Every mutation goes through `AuditService`; nothing writes `audit_logs` directly |

### Account health

`accounts.status` is untouched by this module. Allocation is computed:

```
allocatable  ⟺  accounts.status === 'healthy'  AND  no active blocking problem
```

Blocking statuses are `open`, `in_progress`, `waiting`. Resolved, closed and
cancelled do not block — otherwise every historical problem would disable its
account forever.

---

## 10. Performance

| Concern | Approach |
| ------- | -------- |
| N+1 on the list | Account, assignee and reporter joined in one query. `users` is aliased twice, since assignee and reporter both point at it |
| Customer search | `EXISTS` subquery, not a join — an account with five profiles must not multiply its problem into five rows |
| Account-health checks | `accountsWithActiveProblems` takes a whole page of ids in one grouped read |
| Allocation hot path | Partial index on `(account_id)` where status is blocking, so it stays small as resolved problems accumulate |
| Timeline | Fetched only on the detail page, in parallel with the problem itself |

---

## 11. Tests

| File | Covers |
| ---- | ------ |
| `tests/unit/problem-lifecycle.test.ts` | 23 cases — every legal and illegal transition, blocking statuses, reopen detection, age formatting |
| `tests/integration/problems-module.test.ts` | 32 cases — the full lifecycle against the live database |

The lifecycle tests assert each edge explicitly rather than reading the
production constant: a test that derived its expectations from the same table
the implementation uses would pass no matter what that table said.

The integration suite builds a throwaway account, exercises report → assign →
transition → resolve → reopen → timeline on it, and removes it in `afterAll`.
Nothing pre-existing is modified.

---

## 12. Known Gaps

| Gap | Consequence |
| --- | ----------- |
| No UI verification in an authenticated browser | Every screen is UNVERIFIED visually; the services behind them are covered — see the M08 report |
| Blocking-status list duplicated in `allocation.repository.ts` | ADR-003 forbids a repository importing another module; a unit test pins the copy |
| "Affected Profiles" shows "All 5" rather than a list | Correct per the derived rule, but flat — a per-profile breakdown would need the profile rows in the list query |
| No bulk operations | Assigning twenty problems means twenty actions |
| Severity is never derived from problem type | A `critical` payment problem and a `low` one are equally possible; nothing suggests a default beyond `medium` |

---

## M03 — Problems page bulk actions

Selection works like the Accounts list: by **problem id** (an account can carry
several problems), current page only, and cleared by any change to the query
string — page, search, status, type, assignee, date or sort. The shared helpers
live in `utils/selection.ts`; the toolbar frame is `shared/ui/bulk-action-bar.tsx`,
used by both pages.

| Action | Server-side rule (`bulkProblemsService`) |
| ------ | ---------------------------------------- |
| Resolve | `resolveProblems` re-reads each problem. Not blocking any more (resolved, closed, cancelled) → **skipped**, never reopened. Blocking → `problemResolutionService.resolve` (ownership rule, transition graph, required note, audit). Gone → failed. Offered disabled when nothing selected is blocking |
| Assign | `assignProblems` → `problemAssignmentService.assign` per problem (Super Admin assigns anyone; a Worker only claims/releases; closed and cancelled refused). Already assigned to that person → skipped. Offered to Super Admins |
| Delete | `deleteProblems` — MANAGE_PROBLEMS checked once, then `problemsService.remove` per problem (audited). Removes the problem and its problem notes only; accounts, profiles and customers are untouched. Requires an "I understand" tick |
| Clear selection | — |

Each action is per problem, like the existing bulk actions: a refusal on one
does not undo the others, and every outcome is reported as succeeded, skipped
or failed ("3 resolved, 1 skipped (Already closed.)"). Nothing writes
`accounts.status`: an account whose last blocking problem is resolved or deleted
returns to the Accounts list, Quick Prepare and Quick Replace by derivation.

