# Customers Module

Version: 1.0
Milestone: M05

Authority: `.ai/` decides, this describes.

---

## 1. Responsibilities

| Owns | Does not own |
| ---- | ------------ |
| Customer identity (the normalized phone) | Allocation — that is Quick Prepare |
| Status derivation | Account or profile state |
| Subscription and expiry presentation | Orders (still deferred) |
| Internal notes | Reporting |
| Block / unblock / archive | |

---

## 2. Business Rules

### Status is derived, not stored

M05 asks for status to be computed wherever possible. Three of four are:

| Status | Source |
| ------ | ------ |
| Archived | `deleted_at IS NOT NULL` |
| Blocked | `blocked_at IS NOT NULL` — **the only stored one** |
| Active | holds at least one live subscription |
| Inactive | holds none |

Blocked is the exception because it is a human decision with nothing to infer it
from. Storing Active would duplicate state and go stale the moment a
subscription expired on its own.

**Precedence is itself a rule:** archived → blocked → active → inactive. A
blocked customer holding a live profile is still Blocked; showing them Active
would invite a worker to serve someone deliberately stopped.

### A subscription is live when

`status` is `sold` or `expiring_soon`, **and** the expiry has not passed. A null
expiry is open-ended rather than expired.

### Expiry urgency

`expired` · `today` · `tomorrow` · `soon` (≤3 days) · `later` · `none`.

Both dates reduce to UTC midnight before subtracting, so "expires today" cannot
flip at an arbitrary time of day depending on when the sale happened.

### Identity

The normalized phone remains the identity key, and every number passes through
`lib/phone`. The partial unique index enforces uniqueness among live rows.

### Credentials

Copy is offered for **active allocations only**. An expired profile's PIN may
already belong to somebody else.

The account password is deliberately **not** in the detail payload — ADR-006
Decision 4 keeps reveal-on-request, so the block shows `—` for it and the real
value is fetched from the account page.

---

## 3. Data Flow

```
Server Component  →  customersService  →  repository  →  Adapter  →  Drizzle  →  PG
Client Component  →  hook  →  Server Action  →  customersService  →  …
```

Reads go straight to the service from Server Components. Mutations go through
Server Actions. Authorization lives in the **service**, not the action, so a
future caller reaching the service another way cannot skip it.

### Query cost

| Screen | Queries |
| ------ | ------- |
| List (25 rows) | 2 — page with correlated tallies, plus count |
| Detail | 3 — customer, profiles ⋈ accounts, events |

Neither scales with row count. The list uses correlated aggregates rather than a
join plus GROUP BY, which would multiply the customer row by its profiles before
grouping.

---

## 4. Component Tree

```
app/(app)/customers/page.tsx                [server]
├── CustomersFilters                        [client] URL-backed, debounced 300ms
└── CustomersList                           [server] calls the service
    └── CustomersTable                      [client]
        ├── desktop: sortable table, sticky header
        ├── mobile:  cards
        ├── CustomerStatusBadge · CopyButton · WhatsappButton
        └── EmptyState

app/(app)/customers/[id]/page.tsx           [server] resolves role for canAdminister
└── CustomerDetailView                      [client]
    ├── quick actions — WhatsApp, copy phone, copy link, copy credentials
    ├── AdminActions                        super admin only
    ├── SubscriptionCard × n                ExpiryBadge, account health, link
    ├── NotesEditor                         RHF + Zod
    ├── ReplacementHistory                  derived from `replaced` events
    └── CustomerTimeline                    profile_events, newest first
```

---

## 5. Repository Usage

| Method | Added | Purpose |
| ------ | ----- | ------- |
| `findByNormalizedPhone` | M02 | Identity lookup |
| `existsByNormalizedPhone` | M02 | Duplicate check |
| `create` / `update` / `softDelete` | M02 | |
| **`listWithStats`** | **M05** | List with active/expired tallies |
| **`setBlocked`** | **M05** | The one stored status |

### Search

One `EXISTS` subquery reaches through profiles to accounts, so a customer is
matched by their Netflix email, PIN, profile name or profile number — and still
appears once even when several profiles match.

**Password is deliberately excluded.** It is encrypted with a random IV and
cannot be matched in SQL (ADR-005 Decision 4).

Sort fields resolve through a lookup table; a query-string value never reaches
SQL.

---

## 6. Security

| Action | Worker | Super Admin |
| ------ | ------ | ----------- |
| View list and detail | ✅ | ✅ |
| Open WhatsApp, copy phone/link | ✅ | ✅ |
| Copy active credentials | ✅ | ✅ |
| Edit notes | ✅ | ✅ |
| Block / unblock | ❌ | ✅ |
| Archive | ❌ | ✅ |

Enforced in `customersService` via `requireSuperAdmin`, which reads the role
resolved by `getCurrentUser` from `public.users` (ADR-005 Decision 3).

`canAdminister` on the page only decides what the UI offers. **Hiding a button
is not access control** — a Server Action is an endpoint anyone with a session
can call directly, which is why the check lives in the service.

Every mutation writes an audit entry, with secrets stripped centrally by
`auditService`.

---

## 7. Events

`profile_events` remains the only event source (ADR-006 Decision 1). The
customer timeline is that table filtered by `customer_id`; the account timeline
is the same table filtered by `account_id`. One history, two views, no
duplication.

Replacement history is reconstructed from `replaced` events rather than stored
separately — each swap writes a cancellation and a reallocation, distinguished
by `metadata.outcome`.
