# ADR-016 — Supplier Manager

**Status:** Accepted
**Date:** 2026-10-06
**Milestone:** M10 Supplier Manager
**Supersedes:** nothing
**Amends:** nothing

---

## Context

Some accounts are bought from external suppliers and some are the business's
own. Nothing in the data model could say which, so no screen could answer "how
many accounts do I have that are not mine", and a supplier whose stock keeps
developing payment problems was invisible.

The brief's own constraint shaped most of what follows: a supplier belongs to an
ACCOUNT, never to a profile. The data model already agreed — a profile has no
meaning outside its account — so the relationship had exactly one correct home.

---

## Decision 1 — NULL is "My Account". There is no sentinel supplier row

`accounts.supplier_id` is nullable. NULL means the account is ours.

**Rejected: a reserved "MY ACCOUNT" supplier.** It would be renameable,
deactivatable and countable like a real one, and every query, metric and filter
would have to remember to exclude it. The first one that forgot would report the
business as its own largest supplier. NULL cannot be edited by mistake.

**Consequence.** "My Account" is a WORD, produced in exactly one place
(`account-supplier.tsx`) for every screen that needs it. A NULL supplier is
never rendered as a blank cell: a blank reads as missing data, and ownership is
never missing.

---

## Decision 2 — Supplier status is derived from `deactivated_at`

The brief asks for an active/inactive status. It is stored as a nullable
timestamp and read through `deriveSupplierStatus`.

**Why.** It follows `customers.blocked_at`, whose status is likewise derived
(`deriveCustomerStatus`), and ADR-013's rule: store what a person decides,
derive what a second column would only restate. A stored enum beside the
timestamp would be two sources of truth for one fact, free to disagree the
moment either is written alone — and no CHECK constraint can tie an enum value
to a timestamp's nullness.

It also records WHEN, which a boolean cannot, and it adds no two-value enum that
PostgreSQL could not later shrink — the rollback hazard ADR-013 Decision 2 and
`drizzle/down/README.md` both record.

**Consequence.** There is no `deleted_at` on `suppliers` and no delete path in
the application at all. The brief prefers deactivation (§6, §24); the foreign
key is RESTRICT as the database-level backstop, not as a workflow.

---

## Decision 3 — `name_normalized` is a stored column with a unique index

"Supplier A" and " supplier  a " are one supplier. The service writes the
comparable form — trimmed, whitespace runs collapsed, lower-cased — into
`name_normalized`, and a unique index on it is what makes the rule a guarantee.

**Why a column rather than a functional index.** `customers.phone_normalized` is
the project's one existing precedent for the same problem, and the service needs
the normalisation to LOOK a supplier up by name, which a functional index cannot
give it.

**The index is not partial.** There is no soft delete, and a deactivated
supplier keeps its name: a second "Supplier A" while the first is merely
inactive would make their accounts indistinguishable on screen, which is the
confusion §23 exists to prevent by keeping the old one visible.

`toLowerCase`, never `toLocaleLowerCase` — the value is a database key, and a
key that depends on the server's locale differs between machines.

---

## Decision 4 — Two permissions, and the split is the point

`VIEW_SUPPLIERS` (Super Admin, Worker) and `MANAGE_SUPPLIERS` (Super Admin).

A Worker must see which supplier an account came from to do their job, and must
not be able to rename or deactivate one. This is the brief's §19 and §20, and it
mirrors how `UNASSIGN_SALES` is already separate from `REPLACE_ACCOUNTS`.

**Assigning an account's supplier requires MANAGE_SUPPLIERS**, not
`EDIT_ACCOUNTS`. Ownership decides what every supplier metric says, so it is
supplier management from the other side. Both are Super Admin today, so this
changes nothing for a real user — it means the capability can move later without
the other moving with it.

`assertMayAssignSupplier` is exported from the suppliers module and called by
`accountsService` at BOTH assignment points (creation and reassignment), so the
two cannot drift on who is allowed.

---

## Decision 5 — The metrics have one definition and two spellings

The brief forbids inventing a definition of "problem", "healthy" or "available"
(§12, §16). Those definitions already existed, in two forms the project
deliberately maintains in parallel:

| | TypeScript | SQL |
| --- | --- | --- |
| account buckets | `accountEffectiveStatus` + `accountBucket` | `accountEffectiveBucketSql` (new) |
| allocable profile | `isSellableSlot` + `isProfileFree` + `accountCanAllocate` | `isSellableSlotSql` + `profileIsFreeSql` + `accountCanAllocateSql` |

**Decision.** The supplier list and detail page count in SQL, one aggregate
query for all suppliers. The dashboard groups the rows it ALREADY reads
(`accountStateInputs`, `profileStateInputs`) through the existing TypeScript
tallies, with `supplierId` added to their projections — so the dashboard gains
supplier figures at the cost of zero extra queries.

**And the two are pinned together by a test.** `suppliers-m10.test.ts` builds
one supplier with an account in every bucket and asserts the SQL metrics equal
the dashboard's TypeScript tally, field for field. Writing the rule twice is
only safe if something checks that the two spellings agree; this is that
something.

**One real disagreement was found this way.** The first draft of the dashboard
tally counted `profileCellState(...) === "available"`, which calls a lapsed
allocation "expired". The SQL counts `profileIsFreeSql`, which includes it — the
recycling rule. Those are different numbers for the same supplier on two
screens. The brief asks for "available/**allocable**", so the TypeScript side
was corrected to the three-predicate conjunction. `docs/DASHBOARD_MODULE.md`
already recorded the distinction: stock = available + resellable expired.

---

## Decision 6 — `supplier_id` is omitted from `accountUpdateSchema`

Changing an account's supplier goes through `accountsService.setAccountSupplier`,
not through the generic account update — the same treatment `profileSlots`
already gets, for the same three reasons:

- **Permission.** MANAGE_SUPPLIERS, not EDIT_ACCOUNTS (Decision 4).
- **Audit.** §22 wants the previous and new supplier recorded as an ownership
  change. Through `updateAccount` it would be "account updated" among whatever
  else was in the payload.
- **Eligibility.** An unknown or inactive supplier is refused (§23), which a
  partial update has no place to check.

It IS accepted by `accountInsertSchema`, because naming the supplier while
creating the account is the natural moment — and `createAccount` applies the
same permission and the same eligibility rule before honouring it.

---

## Decision 7 — The account-facing supplier UI lives in the accounts module

`AccountSupplierCell`, `AccountSupplierLine` and
`ChangeAccountSupplierDialog` are in `modules/accounts/components/`, and the
Server Action that assigns a supplier is in `modules/accounts/actions/`.

Not a preference — a build constraint, discovered by the production build. The
suppliers barrel re-exports `server-only` services, so a Client Component that
imports it for a VALUE fails to compile. The same constraint already moved the
profile-state vocabulary into `shared/ui/profile-state.tsx`.

Putting them with accounts is also the honest home: they render account data,
and assigning a supplier mutates an account. Authorization is unaffected —
`setAccountSupplier` requires MANAGE_SUPPLIERS wherever its action file sits.

Type-only imports of `SupplierOption` from the barrel are fine: they are erased.

---

## Decision 8 — `suppliers` is backed up, before `accounts`

Found by the existing backup suite, which asserts the manifest covers every
public table.

`BACKUP_TABLES` is in dependency order and restore inserts in that order, so
`suppliers` sits before `accounts` — otherwise every `supplier_id` would
reference a row that does not exist yet. `RELATIONSHIPS` gains
`accounts.supplier_id → suppliers`, nullable, which is what lets the
pre-restore consistency check accept a file where most accounts have no
supplier.

A unit test asserts the ORDER, which the manifest-coverage check cannot see.

---

## Decision 9 — `audit_entity` gains `'supplier'`, and the down migration leaves it

§21 requires supplier actions to be auditable, and `audit_logs.entity` is an
enum, so the label must exist.

`ALTER TYPE ... ADD VALUE` is additive and safe on live data (PostgreSQL 12+
permits it inside a transaction block, as long as the value is not USED in that
transaction — nothing in 0016 uses it). It is the one part of 0016 the down
migration cannot reverse: there is no `ALTER TYPE ... DROP VALUE`, and
rebuilding the type is the operation that failed in M13 Phase B.

**Decision.** The down migration drops the table, the column, the index and the
policies, and leaves the enum label with a comment saying why. Once the table is
gone no new row can carry it, and any audit entry that already does is history,
which 01_MASTER_RULES.md forbids deleting. An orphan label costs nothing;
rebuilding a type `audit_logs.entity` depends on risks the audit trail.

An account's supplier CHANGE is audited under `account`, not `supplier`: the row
that changed is the account, and `supplierId` is on the account's audit
allow-list, so "from whom, to whom" is answerable from the before/after
snapshots themselves.
