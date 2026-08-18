# ADR-013 — Account Inventory, Sellable Slots and Allocation Validity

**Status:** Accepted
**Date:** 2026-08-12
**Milestone:** M13 Phase B
**Supersedes:** nothing
**Amends:** nothing — see Decision 1, which exists precisely so that no LOCKED
document needed amending.

---

## Context

M13 asked for three things the data model could not express:

1. Accounts that sell fewer than five profiles.
2. Accounts that have their own validity period, separate from the customer's.
3. Allocation that refuses to sell a 90-day subscription on an account with 30
   days of shelf life left.

The Phase A audit found that (2) and (3) were purely additive — no column, rule
or document stood in their way. (1) collided head-on with two LOCKED documents,
and the audit also uncovered a rule that had been documented since M02 and never
implemented.

---

## Decision 1 — Sellable slots, not dynamic profile rows

`01_MASTER_RULES.md` states:

> Each Netflix Account always contains exactly: 5 Profiles.
> Never allow: 4 Profiles / 6 Profiles / **Dynamic profile count**

`03_DATABASE.md` agrees, twice: *"Always contains five profiles"* and *"One
Account ↓ Five Profiles Only."*

The requirement is nonetheless real: an operator buys accounts that carry one,
two or three usable profiles, and the CRM must not offer five.

**Decision.** Every account keeps exactly five `profiles` rows, forever.
`accounts.profile_slots` (1–5) says how many of them are stock. Rows above it
are permanently not for sale.

Both documents stay literally true, `accountsRepository.create` still writes
five rows, and the `profiles_number_range` check and the
`(account_id, profile_number)` unique index are untouched.

**Rejected: amending the documents.** Genuinely dynamic rows would have meant
editing two LOCKED files and revisiting every "exactly five" assumption in the
codebase — the repository, `hasProfileCountAnomaly`, and the integration test
that asserts five rows exist. It would have bought nothing the slot count does
not already buy. The five rows cost five small rows per account and give the
inventory somewhere to grow back into when an operator upgrades a plan.

**Consequence.** `hasProfileCountAnomaly` keeps its exact meaning: a count other
than five still signals corrupt data, because the count is still always five.

---

## Decision 2 — Both sellability and expiry are DERIVED. Nothing is stored.

Neither rule gets a column. `profiles.status` is unchanged, and no enum value
was added.

Every question about expiry is answered by comparing `expiration_date` to the
current date at read time. Every question about sellability is answered by
comparing `profile_number` to `accounts.profile_slots`. Both live in exactly two
places — `account-validity.ts` for TypeScript, `lib/drizzle/predicates.ts` for
SQL — and every caller reaches for one of them.

### The rejected design, and why it was rejected

The first implementation of this milestone **did** add a `not_for_sale` status,
under the "No additional states unless approved" clause in
`01_MASTER_RULES.md`. The argument for it was real and is worth recording:

> Six separate queries across the accounts, dashboard and reports modules
> already filter on `status = 'available'`. A distinct status made every one of
> them correct without being edited. A derived predicate has to be remembered in
> all six — and in the seventh query somebody writes next year.

The design was withdrawn during review, for a reason that outweighs it: **the
stored status could drift from `profile_slots`, and nothing in the database
could prevent it.**

The concrete path was found by inspection, not theory. `profileUpdateSchema` is
built by `createUpdateSchema(profiles, …)` and omits `id`, `accountId`,
`profileNumber`, `createdAt` and `updatedAt` — but **not** `status`. So

```ts
profilesRepository.update(id, { status: "available" })
```

returns a parked slot to stock while `profile_slots` still says it is not stock.
A CHECK constraint cannot catch it, because a CHECK cannot reference another
table. The invariant would have rested entirely on every future caller
remembering — which is the same class of guarantee that failed twice in this
codebase already.

The original ADR text claimed the two "cannot be observed disagreeing." That was
true only of the sanctioned write path, and stating it unconditionally was
wrong.

### What deriving actually cost

Three joins. `dashboard.repository` and two aggregates in `reports.repository`
read `from profiles` with no join to `accounts` and now need one. The other
three sites already joined.

The DRY requirement is met by defining the predicate once, in
`lib/drizzle/predicates.ts`, in two syntaxes — a Drizzle expression for
query-builder callers and `rawSellableSlot(profileAlias, accountAlias)` for the
raw-SQL aggregates. One rule, two spellings, no second definition.

### What it bought

An invariant no write path can break. Sellability cannot be wrong, because
there is nothing to be wrong — the answer is computed from the two facts that
define it, every time it is asked.

`setProfileSlots` became a single-statement update as a result. It still opens a
transaction and still takes row locks, but only for the occupancy check; there
are no profile rows to rewrite, so there is no window in which a rewrite could
half-succeed.

### The rule that remains

**Derive what the clock changes; derive what a column already records.** Store
only what a person decides and nothing else can tell you — which in this
milestone is `profile_slots`, `valid_from` and `valid_until`, and nothing more.

The expired-stock leak is fixed by the same principle. `03_DATABASE.md` has said
*"Expired Profile → Automatically Available if account is Healthy"* since M02;
nothing ever wrote the `expired` status, so expired profiles were never resold
and stock leaked permanently and invisibly. Deriving it from the date makes the
rule true without a sweep job, a scheduled task, or anything that can be late.

---

## Decision 3 — `valid_until` is the column; `duration_days` is an input

An operator buying stock thinks in durations — "a 90-day account". The
allocation rule needs a boundary date. Storing both would be duplicate state
that disagrees the moment either is edited, which `03_DATABASE.md` forbids.

**Decision.** `accounts.valid_until` is stored. `durationDays` is accepted by
the create and bulk-import schemas and converted by `resolveValidity` before the
insert. It is not a column.

`valid_from` IS stored, and is not duplicate state: without it, an account
bought to start next month cannot express that, and the duration originally
purchased is unrecoverable after creation.

**NULL means open-ended, not expired.** This is the load-bearing null check of
the whole milestone. Every account created before M13 has a null `valid_until`,
and reading those as expired would have removed the entire existing inventory
from circulation the moment the column appeared.

---

## Decision 4 — Rejection carries numbers, not just a reason

`evaluateAllocation` returns a `validity` object on **every** evaluation,
successful or not, carrying `remainingDays` and `requestedDays`.

A blocked reason alone (`insufficient_account_validity`) tells an operator that
something is wrong but not what to do. With the numbers, the UI can say:

> Only 18 days remaining. Customer requested 90 days.

which turns a refusal into a decision — sell a shorter subscription, or use
different stock.

The allocation engine carries the same information out through
`AllocationPlan.rejected`, so a shortfall can distinguish *"there is no stock"*
from *"there is stock, but none of it lasts long enough"*. Those have opposite
answers, and reporting both as "not enough profiles" hides the second one.

---

## Decision 5 — Near expiry penalises, never excludes

Accounts with under 15 days of remaining validity are pushed down the allocation
order by a large scoring penalty rather than filtered out.

The penalty (500,000) is sized to outrank every preference below it —
concentration (100,000) and health (max 10,000) together cannot pull a
short-dated account back above a healthy one. It sits deliberately **below**
`coversRequest` (1,000,000): an account that can serve the whole order alone is
still worth choosing, because splitting a customer across two accounts to save a
few days of shelf life is a worse outcome for that customer.

Rejection remains the job of one rule and one rule only:
`requested_duration_days <= account_remaining_days`. The threshold never rejects
anything.

---

## Decision 6 — Bulk import is partial success with a complete report

The M13 brief permits "transactional or an explicitly safe partial-success
model". Phase B first implemented the all-or-nothing one; it was **rejected
during review** and replaced.

The argument against all-or-nothing is the operator's actual job. Importing a
hundred accounts and losing ninety-nine to one typo is a bad trade, and the
defence offered for it — that re-pasting a corrected list produces confusing
duplicate errors — is solved by reporting properly, not by discarding work.

What the brief actually requires is that nothing is created **silently**. That
is what this guarantees:

1. Every row is validated first, against the same schema a single creation uses.
   There is no laxer import path.
2. Valid rows are written under **one transaction**, so a crash cannot leave an
   account without its five profiles.
3. An email already taken skips that row — decided by the unique index via
   `on conflict do nothing`, **not** by a prior `SELECT`. A pre-check would be a
   race: two operators importing overlapping lists would both see the address
   free, and the second would fail a batch it had already cleared.
4. Every submitted row comes back either created or rejected, with a reason and
   the line number the operator actually typed. `BulkCreateResult.submitted` is
   the arithmetic check on that claim, and the tests assert
   `created + rejected === submitted`.

Line numbers survive into the database-level rejections through
`BulkParseResult.lineForEmail`, because "row 47 already exists" is actionable
and "one row already existed" is not.

Parsing and validation live in `bulk-accounts.service.ts`, which has no
database, no `server-only` and no audit context — text in, a verdict per row
out. That is what makes the row-level behaviour testable without a database, and
what lets a future file upload reuse the identical pipeline: an uploaded CSV
becomes a string and enters unchanged.

---

## Decision 7 — Date arithmetic moved to `lib/dates`

Three modules had grown their own copy of "whole days between two dates" by M13,
and account validity would have been the fourth. They agreed only by coincidence.

M13 compares a customer's remaining days against an account's remaining days.
Two subtly different subtractions there produce an off-by-one that sells a
subscription the account cannot cover — on exactly one day, in the boundary
case, which is the hardest kind of bug to ever reproduce.

`lib/dates` is the only implementation. `customer-status.ts` and
`allocation-engine.ts` delegate to it and re-export under their existing names,
so no caller changed.

**Correction.** The first version of this decision claimed both modules
delegated. Only `allocation-engine.ts` did — `customer-status.ts` kept a
byte-identical private copy of `remainingDays`, and the Phase B verification
audit found it. The consolidation is real now: `customer-status.ts` imports from
`lib/dates` and re-exports, and a repository-wide search for the arithmetic
(`86_400_000`, `Date.parse`, `setUTCDate`) returns `lib/dates` alone.

The lesson is recorded rather than quietly fixed: an ADR that describes intended
work as completed work is worse than no ADR, because the next reader trusts it
instead of checking.

---

## Decision 8 — Why this milestone ships ONE migration, and what it cost to learn

The final shape is a single migration, `0011_account_inventory`: three columns,
two checks, one index, no enum change.

It did not start there. The withdrawn `not_for_sale` design required **two**
migrations, and the split was not stylistic. This section records why, because
the constraint applies to any future migration that adds an enum value — and
somebody looking at two small adjacent migrations will otherwise try to merge
them.

### PostgreSQL will not let you use a new enum label in the transaction that adds it

```sql
ALTER TYPE profile_status ADD VALUE 'not_for_sale';
-- ...later, same transaction:
ALTER TABLE profiles ADD CONSTRAINT ... CHECK (status = 'not_for_sale');
--> ERROR: unsafe use of new value "not_for_sale" of enum type profile_status
```

Naming the label in a CHECK expression counts as *using* it. `drizzle-kit`
wraps a migration file in one transaction, so both statements in one file fail.
The rule holds on PostgreSQL 17.6, which is what this project runs.

**If a future migration adds an enum value and anything else references it, it
must be two files.** Merging them will fail at deploy time, not at review time.

### And removing an enum value is far worse

There is no `ALTER TYPE ... DROP VALUE`. Reversing the addition means renaming
the type, creating a replacement, re-typing the column, and dropping the old one.

That down migration was written carefully — and **it failed the first time it
was executed**:

```
ERROR: operator does not exist: profile_status = profile_status_old
```

`ALTER TABLE ... ALTER COLUMN status TYPE` cannot proceed while other objects
still bind typed literals of the old type. Two did: the
`profiles_held_requires_customer` CHECK constraint, and the partial index
`profiles_availability_idx`, whose predicate is `WHERE status = 'available'`.
Both must be dropped before the cast and recreated after. The failure left the
database mid-rollback, with the column on `profile_status_old` and no default,
and it had to be repaired by hand.

This is the strongest practical argument for Decision 2 that is not about
correctness: **an enum value is close to irreversible in a way a nullable column
is not.** The migration this milestone actually ships reverses in six plain
statements, and that rollback is now verified rather than asserted — see
Decision 9.

## Decision 9 — Down migrations are drilled, not assumed

`drizzle/down/README.md` carried an UNVERIFIED warning on every file in that
directory: hand-written, never executed, "reads correctly is not runs
correctly". The enum rollback failure above is exactly what that warning was
about, and it is why the warning is not good enough.

`scripts/rollback-drill.mjs` runs a migration **UP → DOWN → UP** against a
disposable schema and asserts the shape after each step, including that the
constraints still bite after the second up. `0011_account_inventory` passes it.

There is no Docker and no `psql` on the development machine, and Supabase does
not permit `CREATE DATABASE` through the pooler, so "disposable database" means
a throwaway schema on the same instance. The migration's DDL is unqualified, so
a scoped `search_path` sends every statement there and never touches `public`;
the schema is dropped in a `finally` block whether the drill passes or fails.

**Stated limit:** the drill builds a *minimal* table carrying only the columns
the migration touches. It proves the migration's own SQL is reversible. It does
not prove the migration composes with every constraint on the real table — which
is precisely the failure mode the enum rollback hit. A migration that touches an
existing constraint, index or enum must have the real shape declared in the
drill's `TABLES` fixture, or it will pass here and fail in production.

## Decision 10 — A preview request is a validated object, not positional arguments

`quickPrepareService.preview` takes one validated input containing **both**
`profileCount` and `durationDays`, and both are required.

It began as `preview(profileCount: number, durationDays?: number)`. The optional
second parameter was the defect: `previewAllocationAction` was written as
`(profileCount: number)` and never forwarded the duration, so the preview
stopped filtering by account validity while every type still checked and every
test still passed. A worker could be shown an account that the confirm step then
refused — after they had already named it to the customer.

The generalisation is worth stating, because the same shape appears elsewhere in
this codebase: **an optional parameter that changes which business rules apply is
a defect waiting for a caller.** Making the field required turns a silent
behavioural difference into a loud validation error.

`previewAllocationSchema` is derived from `quickPrepareSchema` via `.pick()`, so
the two cannot drift apart in bounds either.

**Test-coverage boundary, stated explicitly.** Server Actions cannot be invoked
in the test environment — `run()` reads the session, which calls `cookies()`,
which throws outside a Next request scope. The tests therefore drive the service,
where the schema lives. The remaining action→service link is one line forwarding
its input unchanged, and the calling hook is typed `{profileCount, durationDays}`
so a partial call fails at compile time. That link is covered by the type system,
not by a test.

## Decision 11 — Reporting measures sellable capacity

`stockTotal`, `stockAvailable` and `allocationRate` in the accounts report, and
`available`, `notForSale` and `utilization` in the profiles report, all count
profile rows **within `profile_slots`**, using `rawSellableSlot` from
`lib/drizzle/predicates`.

Counting raw rows overstates the catalogue by slots nobody can sell, and — worse
— caps a two-slot account at 40% allocation however completely it sells out.
That reads as poor performance rather than as a full account.

Numerator and denominator use the same predicate. A regression test asserts the
rate never exceeds 100%, which is what would happen if only one of them were
filtered.

The first pass fixed `utilization` and missed `allocationRate` and `stockTotal`.
Both were found by the Phase B verification audit and are now covered by
`tests/integration/reports-sellable-slots.test.ts`.

## Consequences

- No new tables, no new enum values, no schema change to `profiles` at all.
- No RLS changes: new columns inherit `accounts_read` and `accounts_write`,
  because RLS is granted per table, not per column.
- No backfill. `DEFAULT 5` and nullable validity make every existing row correct
  at the moment the migration runs.
- One migration, reversible in six statements, drilled UP → DOWN → UP.
- Three queries gained a join to `accounts` (`dashboard.repository`, and two
  aggregates in `reports.repository`). That is the standing cost of Decision 2
  and it is expected to grow by one join per future stock query — the predicate
  in `lib/drizzle/predicates.ts` is what keeps it from growing by one *rule*.
- `evaluateAllocation`'s third parameter changed from a boolean to an options
  object. Two call sites; both updated.
- Report datasets gained `notForSaleProfiles` / `notForSale` columns, and
  profile utilisation is now measured against sellable capacity rather than all
  five rows — otherwise a three-profile account is permanently capped at 60%.
