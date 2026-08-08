# Account Module

Version: 1.0
Milestone: M03
Generated: 2026-08-08

Authority: `.ai/` decides, this describes. Where they disagree, `.ai/` wins.

---

## 1. Responsibilities

`modules/accounts` owns the **account aggregate**: an account, its five profiles,
and their history.

| Owns | Does not own |
| ---- | ------------ |
| Account CRUD and lifecycle | Customers (names, phone numbers) |
| The five-profile invariant | Orders and sales |
| Profile name and PIN edits | Quick Prepare, Smart Stock scoring |
| The unhealthy-account rule | Search, reports, notifications |
| Account timeline from `profile_events` | Backups |

Profiles are **not** a separate module. A profile has no meaning outside its
account, and separating them would put the five-profile rule on the wrong side of
a module boundary.

---

## 2. Component Tree

```
app/(app)/accounts/page.tsx                    [server]
├── CreateAccountDialog                        [client]
│   └── AccountForm  mode="create"             [client] RHF + Zod
├── AccountsFilters                            [client] URL-backed, debounced
└── AccountsList                               [server] calls the service
    └── AccountsTable                          [client]
        ├── desktop: <Table>, sortable, sticky header
        ├── mobile:  cards (04_UI_GUIDELINES.md)
        ├── AccountStatusBadge
        └── EmptyState

app/(app)/accounts/[id]/page.tsx               [server]
├── AccountHeader                              [client]
│   ├── PasswordField        reveal-on-request, ADR-006 D4
│   ├── EditAccountDialog → AccountForm mode="edit"
│   └── AlertDialog × 2      archive · delete
├── blocked banner           when status ≠ healthy
├── anomaly banner           when profile count ≠ 5
├── ProfileCard × 5                            [client]
│   ├── ProfileStatusBadge
│   ├── blocked notice       when the account blocks allocation
│   └── EditProfileDialog    name + PIN only
└── AccountTimeline                            [server]
```

Server Components hold no interaction and are never shipped to the browser.
`AccountTimeline` renders data only, so it stays on the server.

---

## 3. Data Flow

### Reads — server rendering

```
Server Component  →  accountsService  →  repository  →  Adapter  →  Drizzle  →  PG
```

Pages call the service directly. Routing a server-side read through a Server
Action would add a network round trip to reach code already running on the
server.

### Writes — from the browser

```
Client Component
   │  onSubmit
   ▼
Hook (TanStack Query useMutation)
   │  calls the action, unwraps the envelope
   ▼
Server Action            ← the network boundary (ADR-006 D3)
   │  session check, audit context, one service call
   ▼
Service                  ← decides: validation, rules, audit
   │
   ▼
Repository  →  Database Adapter  →  Drizzle  →  PostgreSQL
```

### Why actions return an envelope, not a Result

A `Result` carries an `AppError` **instance**. Class instances do not survive the
server-to-client boundary — the prototype and its methods are stripped, so
`error.userMessage` would arrive as `undefined`.

Actions therefore return `ActionResult<T>`, a plain object. The hook layer's
`unwrapAction` rebuilds a real `ActionError extends AppError` from it, so
`ErrorState`, `isAppError` and the TanStack Query retry policy keep working
unchanged.

```
service   Failure<AppError>
   ↓
action    { ok: false, message, code, fieldErrors }   ← serialisable
   ↓
hook      throw new ActionError(...)                   ← identity restored
   ↓
component error.userMessage
```

---

## 4. Business Rules

### The unhealthy-account rule

> If an account is not Healthy, ALL of its profiles become unavailable for
> allocation, regardless of their own status. No exceptions.
> — `01_MASTER_RULES.md`

Implemented once, in `evaluateAllocation`:

```ts
account.status !== "healthy"   → blocked: "account_not_healthy"
profile.status !== "available" → blocked: "profile_not_available"
otherwise                      → allocatable
```

**Computed, never stored.** Writing an "unavailable" flag onto five profiles on
every status change would duplicate state — which `03_DATABASE.md` forbids — and
would go stale the moment one of those five writes failed.

Exported so Quick Prepare and the Smart Stock Engine call the same function
rather than reimplementing it. One definition, one place to be wrong.

The profile card shows an explicit blocked notice, because a profile reading
"Available" under a Payment Problem account is actively misleading.

### The five-profile rule

Enforced in two halves.

| Half | Where | Guarantees |
| ---- | ----- | ---------- |
| No more than five | Database: `profile_number` 1–5 + unique `(account_id, profile_number)` | Six is impossible |
| No fewer than five | `accountsRepository.create` — one transaction | Four is never observable |

No declarative constraint can require five sibling rows to exist, because rows
insert one at a time and the table would be invalid between the first and the
fifth. So creation writes **account + 5 profiles + 5 `created` events** atomically,
and there is no standalone profile-creation method anywhere in the codebase.

`hasProfileCountAnomaly` surfaces a count other than five on the details page,
which can only happen if rows arrived from an import.

### Editing

| Field | Editable | Why |
| ----- | -------- | --- |
| Profile name | Yes | Raises `name_changed` |
| PIN | Yes | Raises `pin_changed` — the value is **not** written to metadata |
| Profile number | **No** | Fixed for life; not in `profileEditSchema` or `profileUpdateSchema` |
| Create / delete profile | **No** | No such method exists |

An edit that changes nothing writes no event. A timeline full of empty edits is
worse than no timeline.

### Lifecycle

```
healthy ──archive──► archived ──restore──► healthy
   │                     │
   └────── delete ───────┴──► deleted   (soft, terminal)
```

`restore` refuses anything not currently `archived`, and cannot revive a
soft-deleted account — `liveOnly` excludes those rows.

Nothing in the codebase issues a `DELETE` against accounts.

### Audit and events

| Change | audit_logs | profile_events |
| ------ | ---------- | -------------- |
| Account created | `create` | 5 × `created` |
| Account updated | `update` | — |
| Archive / restore / delete | `archive` / `restore` / `delete` | — |
| Password revealed | `update` | — |
| Profile name changed | `update` | `name_changed` |
| PIN changed | `update` | `pin_changed` |

Audit failures **warn rather than fail** the operation. An account that was
created must not be reported as failed because its log row could not be written —
that would cause the user to create a duplicate. The failure is logged loudly.

`auditService` strips `passwordEncrypted` from every snapshot centrally. A rule
applied at eight call sites is a rule that gets missed at the ninth.

---

## 5. Repository Map

| Method | Table | Added in |
| ------ | ----- | -------- |
| `accountsRepository.findById` / `findByEmail` | accounts | M02 |
| `accountsRepository.list` | accounts | M02 |
| **`listWithCounts`** | accounts ⋈ profiles | **M03** |
| `create` | accounts + profiles + profile_events | M02 |
| `update` / `archive` / `softDelete` | accounts | M02 |
| **`restore`** | accounts | **M03** |
| `revealPassword` | accounts | M02 |
| `profilesRepository.listByAccount` / `update` | profiles | M02 |
| `recordEvent` / `listEvents` | profile_events | M02 |
| **`listAccountEvents`** | profile_events | **M03** |
| `findAvailable` | profiles ⋈ accounts | M02 |

`listWithCounts` aggregates with `count(*) FILTER (WHERE ...)` over a LEFT JOIN.
Loading five profiles per row instead would mean 125 rows fetched to display 25.

Sorting resolves through a **lookup table**, never string interpolation — an
arbitrary column name from a query string must not reach SQL.

---

## 6. Security

| Concern | Handling |
| ------- | -------- |
| Password at rest | AES-256-GCM, `lib/crypto`, key never in SQL |
| Password in page payload | **Never.** Reveal-on-request only (ADR-006 D4) |
| Password in cache | Never — reveal is a mutation, held in component state |
| Password in audit | Stripped centrally by `auditService` |
| PIN in event metadata | Never written; only that it changed |
| Session on actions | Rechecked in every action, not assumed from middleware |
| Query-string input | Validated against known sets before reaching the service |
| Delete permission | Refused outright until roles resolve from the session |

### Deletion is currently blocked

`assertMayDelete` refuses every caller. `01_MASTER_RULES.md` restricts deletion
to Super Admins, and although ADR-005 made `public.users.role` authoritative, the
signed-in `AppUser` does not yet carry a role — no service populates the users
table.

Refusing is the safe direction. The alternative would be allowing deletion
because the check cannot run, which is how permission systems fail open.

Archive is unaffected and remains the reversible path.
