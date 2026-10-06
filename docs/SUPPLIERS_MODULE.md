# Suppliers

Where the accounts came from. Decisions in
[ADR-016](../.ai/adr/ADR-016-Supplier-Decisions.md).

---

## 1. The model

```
Supplier ──< Account ──< Profile (×5)
```

A supplier belongs to an **account**. A profile reaches its supplier through
`profiles.account_id`; there is no supplier column on profiles and there must
never be one — it would be duplicate state that drifts the moment an account is
reassigned.

| | |
| --- | --- |
| `accounts.supplier_id` IS NULL | **My Account** — ours |
| `accounts.supplier_id` = a uuid | bought from that supplier |

There is no sentinel "MY ACCOUNT" supplier row. NULL cannot be renamed,
deactivated or counted by mistake. "My Account" is a word, produced once in
`accounts/components/account-supplier.tsx` for every screen.

### Supplier status

Derived from `deactivated_at` by `deriveSupplierStatus`, exactly as a customer's
status is derived from `blocked_at`. No status column, and no delete path: the
application deactivates, and the foreign key is `ON DELETE RESTRICT` as the
database-level backstop.

### Name identity

"Supplier A", " supplier a " and "SUPPLIER  A" are **one** supplier.
`normalizeSupplierName` trims, collapses whitespace runs and lower-cases;
the result is stored in `name_normalized` with a unique index on it. Modelled on
`customers.phone_normalized`.

---

## 2. Files

| Path | Role |
| --- | --- |
| `services/supplier-name.ts` | **Pure.** Normalisation and the name rules. |
| `services/supplier-status.ts` | **Pure.** Derived status; whether a supplier accepts new accounts. |
| `services/suppliers.service.ts` | Permissions, CRUD, audit. |
| `repositories/suppliers.repository.ts` | Reads and writes, including the one metrics query. Not exported. |
| `validation/supplier.schema.ts` | Input contracts. |
| `actions/suppliers.actions.ts` | Supplier CRUD actions. |
| `components/suppliers-table.tsx` | List, filters, status badge. |
| `components/supplier-form.tsx`, `supplier-dialogs.tsx` | Create, edit, deactivate. |
| `dashboard/services/supplier-ownership.ts` | **Pure.** Ownership and per-supplier figures, grouped from rows the dashboard already reads. |
| `dashboard/components/ownership-widgets.tsx` | The two dashboard cards. |
| `accounts/components/account-supplier.tsx` | The account-side cell, line and change dialog — in the accounts module, see ADR-016 D7. |

---

## 3. Metrics

Account figures and profile figures are **different units** and are never added.

| Figure | Definition |
| --- | --- |
| **My Accounts** | live accounts with `supplier_id IS NULL` |
| **Supplier Accounts** | live accounts with `supplier_id IS NOT NULL` |
| **Total Accounts** | the two above, summed once, server-side |
| **Total** (per supplier) | live accounts assigned to it |
| **Healthy** | effective status `healthy` — exactly `accountCanAllocate` |
| **With problems** | a fault recorded on the account, **or** a blocking problem (`open`/`in_progress`/`waiting`) against it |
| **Expired** | healthy and unblocked, but the account's own `valid_until` has passed |
| **Archived** | stored status `archived` |
| **Available profiles** | a PROFILE figure: `isSellableSlot` ∧ `isProfileFree` ∧ `accountCanAllocate` — what Quick Prepare would allocate |

The four account buckets are disjoint and exhaustive over live accounts, so they
sum to the total by construction.

### Where each one is computed

- **Supplier list and detail:** one aggregate query, `count(distinct …) filter
  (where …)` per bucket, composing predicates from `lib/drizzle/predicates.ts`.
  No per-supplier loop.
- **Dashboard:** grouped from `accountStateInputs` and `profileStateInputs` —
  the two queries the dashboard already ran — through `accountEffectiveStatus`
  and the shared profile predicates. **Zero additional queries.**

`tests/integration/suppliers-m10.test.ts` asserts the SQL result equals the
TypeScript tally, field for field, over a supplier with an account in every
bucket. Two spellings of one rule are only safe when something checks they
agree.

---

## 4. Authorization

| | `VIEW_SUPPLIERS` | `MANAGE_SUPPLIERS` |
| --- | --- | --- |
| Super Admin | ✓ | ✓ |
| Worker | ✓ | — |

`VIEW_SUPPLIERS` gates the list, a supplier's detail and metrics, the picker
options, and the ownership figures on the dashboard. `MANAGE_SUPPLIERS` gates
create, rename, deactivate/reactivate, **and assigning or changing an account's
supplier** — including at account creation.

Enforced in the **services**, on every entry point including the reads. The
page checks, the hidden nav item and the absent buttons are what is OFFERED.
RLS says the same thing independently: `suppliers_read` is `is_crm_user()`,
`suppliers_write` is `is_super_admin()`.

---

## 5. Deactivation

A deactivated supplier:

- **keeps every account** assigned to it — they do not become My Account
- is still **named** on those accounts, marked `(inactive)`
- still has a reachable detail page with its full metrics
- **cannot receive a new account**, at creation or by reassignment —
  `requireAssignable` refuses it, and the pickers do not offer it
- is **not offered** in the account form, except as the current supplier of the
  account being edited, so opening the dialog never silently proposes moving it

There is no delete. `ON DELETE RESTRICT` refuses it from any other writer too.

---

## 6. Audit

| Action | Entity | Event |
| --- | --- | --- |
| Supplier created | `supplier` | `supplier_created` |
| Supplier renamed or note edited | `supplier` | `supplier_updated` |
| Supplier deactivated | `supplier` | `supplier_deactivated` |
| Supplier reactivated | `supplier` | `supplier_reactivated` |
| Account's supplier changed | `account` | `account_supplier_changed` |

An ownership change is audited against the **account**, because that is the row
that changed. `supplierId` is on the account's audit allow-list, so the previous
supplier is `before.supplierId` and the new one is `after.supplierId`;
`supplierName` names the new owner so the Logs page needs no join.

`nameNormalized` is deliberately not audited — derived from `name`, and the
audit trail is not where a disagreement between them should be discovered. No
supplier field is a credential: §4 excludes passwords, payment details and API
keys, which is also what makes the RLS read policy safe to widen to Workers.

---

## 7. Database

Migration **0016_suppliers**. Additive only.

```
suppliers         id, name, name_normalized (unique), notes,
                  deactivated_at, created_by, created_at, updated_at
accounts          + supplier_id uuid NULL → suppliers(id) ON DELETE RESTRICT
audit_entity      + 'supplier'
```

Indexes: `suppliers_name_normalized_unique`, `suppliers_name_idx`,
`suppliers_active_idx`, `accounts_supplier_id_idx` (partial, non-null side).

RLS enabled in the same migration that creates the table, with a read policy
for any CRM user and a write policy for Super Admins.

**Nothing is backfilled.** The column is nullable with no default, so every
existing account is correct the moment it runs:

```sql
select count(*) from accounts where supplier_id is null;      -- all of them
select count(*) from accounts where supplier_id is not null;  -- 0
```

A unit test asserts the migration text contains no `UPDATE accounts` and no
`INSERT INTO suppliers`, because "invents no history" is a claim about an
absence and the catalog cannot show one.

`suppliers` is in `BACKUP_TABLES`, **before** `accounts`, since restore inserts
in that order.

---

## 8. Known limitations

- **No bulk supplier import.** Deliberate: §32 reserves importing for M13. The
  model is import-ready — a supplier is a name, so an importer needs only
  `normalizeSupplierName` and the existing create path.
- **The accounts list cannot be SORTED by supplier**, only filtered.
  `SORT_COLUMNS` is an allow-list of real columns; sorting by a joined name
  would need an entry there and an index to be worth offering.
- **No per-supplier history.** A supplier's own changes are in the audit log,
  but there is no supplier timeline screen, and no record of which accounts it
  owned in the past beyond those audit entries.
- **No cost, invoice or payment data**, by design (§4).
- **The account detail page runs one extra query** for its supplier name. One
  account, one query — there is no N+1 — but it is not folded into the main
  detail read.
- **Pre-existing finding, unchanged by M10:** `accountsService.createAccount`
  checks no `CREATE_ACCOUNTS` permission, so any signed-in user may create an
  account. M10 does not widen it — a supplier on that call is separately gated
  by MANAGE_SUPPLIERS — but it is worth fixing on its own.
