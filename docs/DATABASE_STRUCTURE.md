# Database Structure

Version: 1.0
Milestone: M02
Generated: 2026-08-08

Describes the schema as generated. Every table, column, constraint and index
below was read from `drizzle/0000_initial_schema.sql`.

Authority: `.ai/03_DATABASE.md` and ADR-005 decide. This file describes.

---

## 1. Entities

Eight tables.

| Table | Purpose | Mutability |
| ----- | ------- | ---------- |
| `users` | CRM operators | Soft delete |
| `customers` | Netflix buyers | Soft delete |
| `accounts` | Netflix accounts | Archive + soft delete |
| `profiles` | Five per account | Mutable, never deleted independently |
| `profile_events` | Profile history | **Append-only** |
| `audit_logs` | System audit trail | **Append-only, immutable** |
| `backups` | Backup metadata | Mutable lifecycle |
| `settings` | Global settings | Single row |
| `notifications` | In-app notices, one per recipient (M05, migration 0014) | Mutable `read_at` only; removed with their problem |

### Deferred (ADR-005 Decision 1)

`orders` · `issues` · `timeline_events`

(`notifications` arrived in M05 — see below and `docs/SEARCH_AND_NOTIFICATIONS.md`.)

Two consequences worth stating plainly:

- `profiles.current_order_id` does not exist. A foreign key cannot reference a
  missing table.
- `01_MASTER_RULES.md` requires every account to own a timeline. **That
  requirement is not yet satisfied.** `profile_events` covers profile grain only.

---

## 2. Table Detail

### users

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | uuid PK | Same value as `auth.users.id`. Not generated. |
| `name` | text NOT NULL | |
| `email` | text NOT NULL | Unique among live rows |
| `role` | `user_role` NOT NULL | default `worker` |
| `status` | `user_status` NOT NULL | default `active` |
| `last_login_at` | timestamptz | |
| `created_at` / `updated_at` | timestamptz NOT NULL | default `now()` |
| `deleted_at` | timestamptz | Soft delete |

No password column of any kind. Supabase Auth owns credentials (ADR-005
Decision 3). This table is the authoritative home of `role`, resolving the
deferral in ADR-003.

### customers

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | uuid PK | `gen_random_uuid()` |
| `name` | text | Optional — identity is the phone number |
| `phone_original` | text NOT NULL | As typed |
| `phone_normalized` | text NOT NULL | **The identity key.** Unique among live rows |
| `whatsapp_url` | text NOT NULL | Derived, stored |
| `notes` | text | |
| `first_purchase_at` / `last_purchase_at` | timestamptz | |
| `created_at` / `updated_at` / `deleted_at` | timestamptz | |

Three phone columns is the one place the "never duplicate" rule is knowingly
bent, and `customer.schema.ts` enforces that all three are updated together — a
partial update would leave the identity key disagreeing with the chat link.

### accounts

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | uuid PK | |
| `email` | text NOT NULL | Unique among live rows |
| `password_encrypted` | text NOT NULL | AES-256-GCM, `v1:iv:tag:data` |
| `status` | `account_status` NOT NULL | default `healthy` |
| `health_score` | integer NOT NULL | default 100, 0–100 |
| `country` / `notes` | text | |
| `created_by` | uuid → users | ON DELETE SET NULL |
| `created_at` / `updated_at` | timestamptz NOT NULL | |
| `archived_at` / `deleted_at` | timestamptz | Two distinct lifecycle states |

`subscription_type` is deliberately absent — no document defines its values
(ADR-005 Decision 6).

### profiles

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | uuid PK | |
| `account_id` | uuid NOT NULL → accounts | **ON DELETE CASCADE** |
| `profile_number` | smallint NOT NULL | 1–5, unique per account |
| `profile_name` | text | |
| `pin` | text | Indexed, not encrypted — must be searchable |
| `status` | `profile_status` NOT NULL | default `available` |
| `customer_id` | uuid → customers | ON DELETE SET NULL |
| `worker_id` | uuid → users | ON DELETE SET NULL |
| `sale_date` / `expiration_date` | date | `date`, not timestamp — whole days |
| `duration_days` | integer | Unit in the name (ADR-005 Decision 6) |
| `notes` | text | |
| `created_at` / `updated_at` | timestamptz NOT NULL | |

No `deleted_at`: a profile is one of exactly five and cannot be removed
individually.

### profile_events

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | uuid PK | |
| `profile_id` | uuid NOT NULL → profiles | ON DELETE CASCADE |
| `event_type` | `profile_event_type` NOT NULL | 9 values |
| `actor_user_id` | uuid → users | Null for system events |
| `customer_id` | uuid → customers | ON DELETE SET NULL |
| `data` | jsonb NOT NULL | default `{}` — the extensibility seam |
| `notes` | text | |
| `created_at` | timestamptz NOT NULL | |

No `updated_at`, no `deleted_at`. A column that does not exist cannot be written
to by mistake.

### audit_logs

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | uuid PK | |
| `entity` | `audit_entity` NOT NULL | |
| `entity_id` | uuid NOT NULL | **Deliberately not a foreign key** |
| `action` | `audit_action` NOT NULL | |
| `before` / `after` | jsonb | Must never contain secrets |
| `user_id` | uuid → users | **ON DELETE SET NULL**, never cascade |
| `actor_email` | text | Denormalised so entries survive user deletion |
| `ip_address` / `user_agent` | text | |
| `created_at` | timestamptz NOT NULL | |

`entity_id` is not a foreign key so the log can outlive what it describes —
otherwise a delete entry would be impossible to write.

### backups

`id`, `type`, `status`, `filename`, `size_bytes` (bigint), `checksum`,
`is_restore_point`, `created_by` → users, `error_message`, `created_at`,
`completed_at`, `verified_at`.

`verified` is a separate status from `completed`: a backup that finished writing
is not yet known to be restorable.

### settings

`id`, `singleton` (boolean, always true, uniquely indexed), `values` (jsonb),
`updated_by` → users, `created_at`, `updated_at`.

`values` is an open record because no document specifies a concrete setting.
Settings should be promoted to typed columns as they are defined — jsonb is the
honest placeholder, not the destination.

### notifications (M05)

`id`, `recipient_id` → users (cascade), `actor_id` → users (set null), `type`
(checked: `problem_reported`, `problem_assigned`, `problem_resolved`,
`problem_reopened`), `title`, `body`, `entity_type` + `entity_id` (both or
neither; no foreign key — resolved to a route by a closed map), `dedupe_key`,
`read_at`, `created_at`.

Unique `(recipient_id, dedupe_key)` makes a repeated event a no-op. Indexed by
`(recipient_id, created_at desc)` for the panel and partially by `recipient_id
where read_at is null` for the unread count. RLS on, no grants to `anon` or
`authenticated`, and a single SELECT policy on the recipient's own rows.

---

## 3. Enums

Nine.

| Enum | Values |
| ---- | ------ |
| `account_status` | healthy · payment_problem · incorrect_password · invalid_email · something_went_wrong · archived · deleted |
| `profile_status` | available · reserved · sold · expiring_soon · expired |
| `user_role` | super_admin · worker |
| `user_status` | active · disabled |
| `profile_event_type` | created · sold · replaced · extended · expired · pin_changed · name_changed · customer_changed · status_changed |
| `audit_action` | create · update · delete · restore · archive · login · logout |
| `audit_entity` | user · customer · account · profile · backup · settings |
| `backup_type` | hourly · daily · manual |
| `backup_status` | pending · running · completed · failed · verified |

`expiring_soon` and `expired` are functions of `expiration_date`, not user
actions. Nothing in M02 writes them.

---

## 4. Relationships

```
auth.users ──1:1──► users
users ──1:N──► accounts (created_by)
users ──1:N──► profiles (worker_id)
users ──1:N──► audit_logs · backups · settings · profile_events

accounts ──1:5──► profiles          CASCADE
profiles ──1:N──► profile_events    CASCADE

customers ──1:N──► profiles         SET NULL
customers ──1:N──► profile_events   SET NULL
```

### Delete behaviour, and why

| FK | Behaviour | Reason |
| -- | --------- | ------ |
| `users.id → auth.users.id` | CASCADE | Removing the identity removes the CRM profile |
| `profiles.account_id` | CASCADE | Composition — a profile has no meaning alone |
| `profile_events.profile_id` | CASCADE | History has no subject without its profile |
| `profiles.customer_id` | SET NULL | Deleting a customer frees the profile, never destroys it |
| `profile_events.customer_id` | SET NULL | The event still happened |
| `audit_logs.user_id` | SET NULL | **Cascade would let deleting a user erase what they did** |
| `accounts.created_by`, `backups.created_by`, `settings.updated_by` | SET NULL | Attribution is not worth destroying a record for |

---

## 5. Constraints

### Unique (all partial, excluding soft-deleted rows)

| Name | Columns |
| ---- | ------- |
| `users_email_unique_live` | email WHERE deleted_at IS NULL |
| `customers_phone_normalized_unique_live` | phone_normalized WHERE deleted_at IS NULL |
| `accounts_email_unique_live` | email WHERE deleted_at IS NULL |
| `profiles_account_number_unique` | (account_id, profile_number) |
| `settings_singleton_unique` | singleton |

Partial scoping matters: a plain unique index would permanently burn an email or
phone number the first time a record was deleted.

### Check

| Name | Rule |
| ---- | ---- |
| `accounts_health_score_range` | 0 ≤ health_score ≤ 100 |
| `accounts_email_shape` | Basic address shape |
| `profiles_number_range` | 1 ≤ profile_number ≤ 5 |
| `profiles_duration_positive` | duration_days > 0 or null |
| `profiles_expiry_after_sale` | expiration_date ≥ sale_date |
| `profiles_held_requires_customer` | sold/reserved/expiring_soon ⇒ customer set; available ⇒ customer null; expired unconstrained |
| `customers_phone_normalized_digits` | 6–20 digits, no symbols |
| `backups_completed_has_artifact` | completed/verified ⇒ filename + checksum + completed_at |
| `backups_failed_has_reason` | failed ⇒ error_message |
| `backups_verified_has_timestamp` | verified ⇒ verified_at |
| `settings_singleton_true` | singleton = true |

### The five-profile rule

The database enforces **half** of it:

- `profile_number` constrained to 1–5
- `(account_id, profile_number)` unique

Together those make **six** profiles impossible. They cannot make **four**
impossible — no declarative constraint can require that five sibling rows exist,
because rows are inserted one at a time and the table would be invalid between
the first and the fifth.

The other half is `accountsRepository.create`, which writes the account and all
five profiles in one transaction. There is deliberately no standalone profile
creation method anywhere in the codebase.

---

## 6. Indexes

**39 declared**, plus 8 primary-key indexes created implicitly = **47 in the
database**. Verified against the live schema after migration.

| Table | Indexes |
| ----- | ------- |
| users | 4 — email (unique partial), role, status, created_at |
| customers | 5 — phone_normalized (unique partial), phone_original, name, created_at, last_purchase_at |
| accounts | 6 — email (unique partial), status, created_at, created_by, country, **stock_selection** |
| profiles | 9 — account+number (unique), account_id, status, customer_id, worker_id, pin, sale_date, **expiration_date**, **availability** |
| profile_events | 6 — **account+created DESC**, profile+created DESC, type, customer_id, user_id, created_at DESC |
| audit_logs | 4 — entity+entity_id+created DESC, user+created DESC, action, created_at DESC |
| backups | 4 — type, status, created_at DESC, **restore_point** |
| settings | 1 — singleton (unique) |

`profile_events.account_created_idx` was added in M03 (ADR-006 Decision 2) to
serve the account timeline. It is the sixth index on that table and the reason
this count moved from 38 to 39.

### Partial indexes and why

| Index | Predicate | Reason |
| ----- | --------- | ------ |
| `accounts_stock_selection_idx` | deleted_at IS NULL | Smart Stock hot path, ordered by health_score DESC so it reads the front instead of sorting |
| `profiles_expiration_date_idx` | expiration_date IS NOT NULL | Expiry sweeps scan a minority of 500,000 rows |
| `profiles_availability_idx` | status = 'available' | Stock lookup touches only free profiles |
| `backups_restore_point_idx` | is_restore_point = true | The set a human browses when recovering |

Descending indexes on `created_at` match how history is always read: newest
first.

---

## 7. Repository Map

| Repository | Module | Tables |
| ---------- | ------ | ------ |
| `usersRepository` | `modules/users` | users |
| `customersRepository` | `modules/customers` | customers |
| `accountsRepository` | `modules/accounts` | accounts (+ profiles, profile_events on create) |
| `profilesRepository` | `modules/accounts` | profiles, profile_events |
| `auditRepository` | `modules/audit` | audit_logs |
| `backupsRepository` | `modules/backups` | backups |
| `settingsRepository` | `modules/settings` | settings |

Profiles live in the accounts module rather than their own. A profile has no
meaning outside its account, and separating them would put the five-profile rule
on the wrong side of a module boundary.

### Deliberate omissions

| Missing | Why |
| ------- | --- |
| `profilesRepository.create` | Would bypass the five-profile rule |
| `auditRepository.update` / `.delete` | The log is immutable |
| profile-event update or delete | History is never modified |
| `settingsRepository.create` | The unique index permits one row; `ensureExists` handles it |

### Shared contract

Every repository returns `Result<T>`, never null. A missing row is a `Failure`
carrying `NotFoundError`. Reads exclude soft-deleted rows by default.

Paginated lists run the page query and the count in **one transaction**, so the
total can never describe a different set than the rows on screen.

---

## 8. Data Flow

```
Component  →  Service  →  Repository  →  Database Adapter  →  Drizzle  →  PostgreSQL
                              │                  │
                    describes WHAT        decides HOW:
                    using the schema      connection, transaction,
                    vocabulary            retry, error translation
```

ADR-005 Decision 5 moved the enforced boundary from the query builder to the
**connection**. Repositories may import `drizzle-orm` and the schema; they may
not import `@/lib/drizzle/client` or `postgres`. ESLint enforces this, verified
with deliberate violations.

### Write path — creating an account

```
accountsRepository.create(input, createdBy)
  │
  ├─ encryptSecret(password)          ← before the transaction opens
  │     failure → return, nothing written
  │
  └─ databaseAdapter.transaction
        ├─ INSERT account (password_encrypted)
        ├─ INSERT 5 profiles (numbers 1..5)
        └─ INSERT 5 profile_events ('created')
        
     all five, or none
```

### Error path

```
PostgreSQL error
  → Adapter: retryable?  (40001, 40P01, 08xxx, 57P01/03)
      yes → backoff with jitter, up to 3 attempts
      no  → translate by SQLSTATE
             23505 → ConflictError
             23503 → ConflictError
             23502 / 23514 → DatabaseError
             else  → DatabaseError
  → Failure<AppError> to the repository
  → Service decides
  → Hook unwraps, throws
  → Component renders error.userMessage
```

A raw driver message never leaves the Adapter.

---

## 9. Security Notes

| Concern | Handling |
| ------- | -------- |
| Account passwords | AES-256-GCM in `lib/crypto`. Key never enters SQL. |
| Key placeholder | All-zero key is detected; encryption refuses to run. |
| Password in audit snapshots | Callers must strip `password_encrypted` before writing `before`/`after`. **Convention only — not enforced.** |
| Secrets in profile_events `data` | Same. Convention only. |
| Audit immutability | No update/delete methods exist. **Not enforced at the database level.** |
| RLS | **Not implemented.** No policy exists on any table. |

The last three are real gaps, not oversights waiting to be discovered. See the
final report's risk list.
