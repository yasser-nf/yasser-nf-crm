# Entity Relationship Diagram

Version: 1.0
Milestone: M02
Generated: 2026-08-08

---

## Mermaid

```mermaid
erDiagram
    AUTH_USERS ||--|| USERS : "shares id"

    USERS ||--o{ ACCOUNTS : "created_by"
    USERS ||--o{ PROFILES : "worker_id"
    USERS ||--o{ PROFILE_EVENTS : "actor_user_id"
    USERS ||--o{ AUDIT_LOGS : "user_id"
    USERS ||--o{ BACKUPS : "created_by"
    USERS ||--o{ SETTINGS : "updated_by"

    ACCOUNTS ||--|{ PROFILES : "exactly 5"
    PROFILES ||--o{ PROFILE_EVENTS : "history"

    CUSTOMERS ||--o{ PROFILES : "currently holds"
    CUSTOMERS ||--o{ PROFILE_EVENTS : "concerned"

    AUTH_USERS {
        uuid id PK "Supabase-owned"
        text email "credentials live here"
    }

    USERS {
        uuid id PK "= auth.users.id, CASCADE"
        text name
        text email UK "unique among live rows"
        user_role role "super_admin | worker"
        user_status status "active | disabled"
        timestamptz last_login_at
        timestamptz created_at
        timestamptz updated_at
        timestamptz deleted_at "soft delete"
    }

    CUSTOMERS {
        uuid id PK
        text name "optional"
        text phone_original "as typed"
        text phone_normalized UK "IDENTITY KEY"
        text whatsapp_url "derived, stored"
        text notes
        timestamptz first_purchase_at
        timestamptz last_purchase_at
        timestamptz created_at
        timestamptz updated_at
        timestamptz deleted_at
    }

    ACCOUNTS {
        uuid id PK
        text email UK "unique among live rows"
        text password_encrypted "AES-256-GCM"
        account_status status "7 values"
        integer health_score "0-100"
        text country
        text notes
        uuid created_by FK "SET NULL"
        timestamptz created_at
        timestamptz updated_at
        timestamptz archived_at
        timestamptz deleted_at
    }

    PROFILES {
        uuid id PK
        uuid account_id FK "CASCADE"
        smallint profile_number "1-5, unique per account"
        text profile_name
        text pin "indexed, not encrypted"
        profile_status status "5 values"
        uuid customer_id FK "SET NULL"
        uuid worker_id FK "SET NULL"
        date sale_date
        date expiration_date
        integer duration_days
        text notes
        timestamptz created_at
        timestamptz updated_at
    }

    PROFILE_EVENTS {
        uuid id PK
        uuid profile_id FK "CASCADE"
        profile_event_type event_type "9 values"
        uuid actor_user_id FK "SET NULL"
        uuid customer_id FK "SET NULL"
        jsonb data "extensibility seam"
        text notes
        timestamptz created_at "APPEND-ONLY"
    }

    AUDIT_LOGS {
        uuid id PK
        audit_entity entity
        uuid entity_id "NOT a foreign key"
        audit_action action
        jsonb before
        jsonb after
        uuid user_id FK "SET NULL, never cascade"
        text actor_email "denormalised on purpose"
        text ip_address
        text user_agent
        timestamptz created_at "IMMUTABLE"
    }

    BACKUPS {
        uuid id PK
        backup_type type "hourly | daily | manual"
        backup_status status "5 values"
        text filename
        bigint size_bytes
        text checksum
        boolean is_restore_point
        uuid created_by FK "SET NULL"
        text error_message
        timestamptz created_at
        timestamptz completed_at
        timestamptz verified_at
    }

    SETTINGS {
        uuid id PK
        boolean singleton UK "always true, one row"
        jsonb values
        uuid updated_by FK "SET NULL"
        timestamptz created_at
        timestamptz updated_at
    }
```

---

## ASCII

```
                        ┌──────────────────────┐
                        │  auth.users          │  Supabase-owned.
                        │  (credentials)       │  Never in our migrations.
                        └──────────┬───────────┘
                                   │ 1:1, shared id, CASCADE
                        ┌──────────▼───────────┐
                        │  users               │
                        │  role · status       │  ◄── authoritative role
                        └──────────┬───────────┘
                                   │
        ┌───────────┬──────────────┼──────────────┬───────────┐
        │           │              │              │           │
   created_by   worker_id     actor_user_id    user_id    created_by
        │           │              │              │           │
        ▼           ▼              ▼              ▼           ▼
┌───────────────┐   │      ┌──────────────┐ ┌──────────┐ ┌─────────┐
│  accounts     │   │      │profile_events│ │audit_logs│ │ backups │
│  status       │   │      │  APPEND-ONLY │ │ IMMUTABLE│ │         │
│  health 0-100 │   │      └──────▲───────┘ └──────────┘ └─────────┘
│  pw encrypted │   │             │
└───────┬───────┘   │             │ CASCADE
        │           │             │
        │ 1:5 CASCADE             │
        │           │             │
        ▼           ▼             │
┌────────────────────────────┐    │
│  profiles                  │────┘
│  number 1-5, unique/acct   │
│  status · pin · dates      │
└───────────▲────────────────┘
            │ SET NULL
            │
┌───────────┴────────────────┐        ┌──────────────┐
│  customers                 │        │  settings    │
│  phone_normalized = IDENTITY│       │  one row only│
└────────────────────────────┘        └──────────────┘
```

---

## Cardinality

| Relationship | Cardinality | Delete |
| ------------ | ----------- | ------ |
| auth.users → users | 1 : 1 | CASCADE |
| accounts → profiles | 1 : **exactly 5** | CASCADE |
| profiles → profile_events | 1 : N | CASCADE |
| customers → profiles | 1 : N (currently held) | SET NULL |
| customers → profile_events | 1 : N | SET NULL |
| users → accounts | 1 : N (creator) | SET NULL |
| users → profiles | 1 : N (worker) | SET NULL |
| users → audit_logs | 1 : N | SET NULL |
| users → backups | 1 : N | SET NULL |
| users → settings | 1 : N (updater) | SET NULL |

The `1 : exactly 5` is the only fixed cardinality in the schema. The database
guarantees "no more than 5"; `accountsRepository.create` guarantees "no fewer",
by writing all six rows in one transaction.

---

## Deferred entities

Not created in M02 (ADR-005 Decision 1). Shown so the intended shape is not lost:

```
orders            profiles ──1:N──► orders ◄──1:N── customers
                  users ──1:N──► orders
                  Would restore profiles.current_order_id.

issues            accounts ──1:N──► issues
                  "Issues belong to Accounts. Never Profiles." (03_DATABASE.md)

timeline_events   accounts ──1:N──► timeline_events
                  Account-grain history. Required by 01_MASTER_RULES.md
                  and still OUTSTANDING.

notifications     users ──1:N──► notifications
```

---

## Reading the diagram

- **`||--|{`** — one to many, at least one (accounts → profiles)
- **`||--o{`** — one to many, optionally zero
- **`||--||`** — one to one
- **UK** — unique. All uniques except `settings.singleton` and
  `(account_id, profile_number)` are **partial**, excluding soft-deleted rows.
- **PK** — primary key. All are uuid; only `users.id` is not generated, because
  it comes from Supabase Auth.
