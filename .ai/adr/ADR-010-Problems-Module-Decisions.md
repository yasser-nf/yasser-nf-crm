# ADR-010
# Problems Module Decisions

Status: ACCEPTED

Date: 2026-08-11

Owner: Yasser Saidi

Amends: 03_DATABASE.md, ADR-005, ADR-006

---

# Context

Milestone M08 builds the Problems module — the single source of truth for every
account fault.

03_DATABASE.md already specifies an `issues` table, which ADR-005 Decision 1
deferred. M08 builds it. Four questions the documents do not answer were put to
the project owner; two were answered directly and two were stated with a
recommendation and built on that basis after no objection.

---

# Decision 1 — The Transition Graph

## Context

The M08 brief lists six statuses and requires that "only documented transitions
are allowed" and that invalid ones be rejected. No document defined the
transitions, and 01_MASTER_RULES.md forbids inventing business rules.

## Decision

```
open        → in_progress | waiting | resolved | cancelled
in_progress → waiting | resolved | cancelled
waiting     → in_progress | resolved | cancelled
resolved    → closed | open
closed      → open
cancelled   → (terminal; Super Admin may close)
```

Resolving always requires a resolution note, `resolved_by` and `resolved_at`.
Reopening returns to `open` and increments `reopen_count`.

## Why these edges

`in_progress` cannot return to `open`. Work that has started is either parked
(`waiting`), finished, or abandoned — a silent slide back to `open` would lose
the fact that somebody had already looked.

Nothing reaches `closed` without passing through `resolved`. Closing directly
would bypass the mandatory resolution note, which is the only durable record of
what was actually done.

`resolved` and `closed` can both be reopened, because a fault that returns is
the normal case and forcing a new problem would sever it from its history.

`cancelled` is terminal. It means the problem should never have been raised, so
there is nothing to resume. The single exception is a Super Admin closing one,
which exists because the M08 brief states Workers may not close cancelled
problems — implying somebody can.

## Location

`services/problem-lifecycle.ts`, and nowhere else. The detail screen offers
buttons from the same `allowedTransitions` the service checks, so the UI cannot
present a move the server will reject.

---

# Decision 2 — Problems Are Account Grain

## Context

03_DATABASE.md states plainly: **"Issues belong to Accounts. Never Profiles."**

The M08 brief asks for "Affected Profiles" on both screens and for creating a
problem from a Profile.

## Decision

The problem attaches to the account. Affected profiles are **derived**, never
stored.

Reporting from a profile raises the problem on that profile's account.

## Why this satisfies both

01_MASTER_RULES.md already says: if an account is not Healthy, ALL of its
profiles become unavailable. "Affected profiles" is therefore exactly the
account's five profiles — a derived fact, not a stored relationship.

All four documented problem types are account-level: a payment failure, a wrong
password, an invalid email and "something went wrong" are properties of the
account, not of one profile out of five.

## Rejected

A join table naming specific profiles. It would contradict a rank-4 LOCKED
document, add a table with no documented use, and create a second definition of
what a problem affects.

---

# Decision 3 — The Timeline Is Derived, Not Stored

## Context

The M08 brief asks for a timeline of every change, and in the same breath
forbids duplicating timeline and audit structures. ADR-006 Decision 1 already
cancelled `timeline_events` outright.

## Decision

There is no problem-events table. The timeline has exactly two sources:

`audit_logs` filtered to `entity = 'issue'`

`issue_notes`

`services/problem-timeline.service.ts` translates each audit diff into a
sentence — "Assigned", "Severity changed from low to high", "Reopened (time 2)" —
and merges the notes in.

Assignment history is part of this. Every assignment change writes an audit
entry with before and after, so the history is already recorded and a separate
`assignment_history` table would store the same fact twice.

## Why

Audit already records every mutation with `before` and `after`, for reasons that
have nothing to do with this screen. Every event a timeline would show is
already implied by a diff that exists. Writing a parallel history would double
every write and create two records that can disagree.

The same reasoning produced the M06 activity feed.

## Consequence

`audit_entity` gains `issue`. Migration 0008 recreates the enum, because
`ALTER TYPE … ADD VALUE` cannot run inside a transaction block.

Notes are the one thing genuinely stored, in `issue_notes`: a note is not a
change to an entity — it has an author and a body and nothing before or after.
The table is append-only and deliberately has no `updated_at`.

---

# Decision 4 — Account Health Is Computed, Never Written

## Decision — stated by the project owner, verbatim

`accounts.status` remains the persisted **operational** status.

Problems never write `accounts.status` directly.

Account health is computed by `evaluateAllocation()` from:

- `accounts.status`
- active blocking problems

An account is allocatable only when:

```
accounts.status == 'healthy'  AND  no active blocking problem exists
```

## Why

The `account_status` enum already contains values matching the problem types
(`payment_problem`, `incorrect_password`, `invalid_email`,
`something_went_wrong`), which makes writing the status from a problem look
natural. It would store the same fact twice, and a manual status edit could then
silently disagree with the open problems.

Computing the conjunction keeps one fact in one place, and matches the pattern
already used for profile availability and customer status.

## Blocking statuses

`open`, `in_progress`, `waiting`. Resolved, closed and cancelled do not block —
otherwise every historical problem would disable its account permanently.

## Consequence

`evaluateAllocation` gains a third input and a new `blockedReason` of
`account_has_problem`.

Quick Prepare's eligibility query gains a `NOT EXISTS` clause. It is expressed in
SQL rather than filtered afterwards because the allocation read takes row locks
with `SKIP LOCKED` — filtering after the fact would lock profiles the engine then
discards, holding stock nobody can allocate.

That SQL duplicates the blocking-status list, because ADR-003 forbids a
repository importing another module. A unit test asserts the copy matches
`BLOCKING_STATUSES`.

---

# Decision 5 — Visibility Is Global, Mutability Is Ownership-Based

## Decision — stated by the project owner, verbatim

Workers may report a problem, view the complete problem list, view every problem
detail, add notes to problems assigned to them, update only problems assigned to
them, and resolve only problems assigned to them.

Workers may NOT delete problems, change severity, reassign problems they do not
own, modify system configuration, or close cancelled problems.

Super Admin has unrestricted access.

## Implementation

Three permissions, because ownership is not expressible as one:

`REPORT_PROBLEMS` · `VIEW_PROBLEMS` — granted to Workers

`MANAGE_PROBLEMS` — Super Admin only: delete, change severity, reassign a
problem somebody else owns

Ownership depends on the row, so it is checked in the service by
`assertMayMutate`, not by a permission.

## The one extension

A Worker may **claim** an unassigned problem for themselves, and release their
own. Without that, nothing a Worker reported could ever be worked on without an
administrator, which would make the Quick Prepare integration pointless.

A Worker still cannot hand a problem to somebody else, or take one that is
already owned.

## Consequence

`config/roles.ts` gains two Worker permissions. That list was previously taken
verbatim from the M06 brief, so extending it is recorded here rather than
treated as a detail.

---

# Final Decision

These decisions are adopted. Changing any requires a new ADR and approval from
the project owner.

---

END OF ADR-010
