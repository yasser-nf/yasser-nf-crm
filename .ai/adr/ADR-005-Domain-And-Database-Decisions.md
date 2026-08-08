# ADR-005
# Domain And Database Decisions

Status: ACCEPTED

Date: 2026-08-08

Owner: Yasser Saidi

Amends: 03_DATABASE.md, CURRENT_MILESTONE.md, ADR-003

---

# Context

Milestone M02 implements the data layer. Preparing it surfaced five conflicts
between documents that are all marked LOCKED.

03_DATABASE.md and CURRENT_MILESTONE.md were written four seconds apart and
contradict each other, so the priority order in 05_DEVELOPMENT_WORKFLOW.md could
not resolve the disagreement on its own — a lower-priority document was not
merely stale, it was simultaneous.

All five decisions below were put to the project owner and approved on
2026-08-08.

---

# Decision 1 — Table Scope

## Decision

Milestone M02 creates eight tables.

users

customers

accounts

profiles

profile_events

audit_logs

backups

settings

## Deferred

orders

issues

timeline_events

notifications

## Why

03_DATABASE.md requires all four deferred tables and CURRENT_MILESTONE.md
requires orders. The project owner scoped M02 to the eight above.

Partially building a table is worse than not building it. An orders table with no
sale flow would need altering the moment the flow existed, and every migration
against a live production database carries risk that an unused table does not
justify.

## Consequences

profiles.current_order_id is NOT created. 03_DATABASE.md lists it, but a foreign
key cannot point at a table that does not exist. It arrives with orders.

profile_events partially covers what timeline_events was meant to provide, but
only at profile grain. Account-level history still requires timeline_events in a
later milestone.

01_MASTER_RULES.md states that every account owns a timeline. That requirement is
NOT satisfied by M02 and remains outstanding.

---

# Decision 2 — Enum Conflict

## Decision

03_DATABASE.md and 01_MASTER_RULES.md prevail over CURRENT_MILESTONE.md.

### account_status

healthy

payment_problem

incorrect_password

invalid_email

something_went_wrong

archived

deleted

### profile_status

available

reserved

sold

expiring_soon

expired

### user_role

super_admin

worker

## Rejected

CURRENT_MILESTONE.md proposed account_status of Available / Full / Problem /
Disabled with a separate ProblemType enum, profile_status with Problem instead of
Expiring Soon, and a role named Admin.

Rejected because two LOCKED documents agree against it, the priority order in
05_DEVELOPMENT_WORKFLOW.md ranks both above CURRENT_MILESTONE.md, and
config/roles.ts from M01 already implements super_admin / worker.

A hybrid keeping both account_status and ProblemType was also rejected: the two
would store overlapping information, which 03_DATABASE.md forbids.

## Consequence

CURRENT_MILESTONE.md is corrected rather than followed.

## Note on expiring_soon and expired

Both are stored enum values, but neither is set by a user action. They are
functions of expiration_date and today's date.

M02 stores the values only. Whatever transitions a profile into them — a
scheduled job, a database trigger, or a computed read — is a business concern and
belongs to the milestone that owns expiry. Nothing in M02 writes them.

---

# Decision 3 — Users And Supabase Auth

## Decision

public.users.id references auth.users(id) ON DELETE CASCADE.

There is no password column of any kind in public.users.

## Why

ADR-001 adopted Supabase Auth, which already stores credentials in auth.users.

CURRENT_MILESTONE.md proposed a password_hash column. That would create a second
credential store, contradicting ADR-001 and 03_DATABASE.md's "Never duplicate
business data".

Sharing the primary key means there is exactly one user identity in the system.
No synchronisation, no drift, no question about which identifier is authoritative.

## Consequence

This resolves the role storage that ADR-003 deferred. `public.users.role` is now
the authoritative location, and role-based access control is unblocked.

A row in public.users cannot exist without an auth.users row. Creating a CRM user
therefore means creating a Supabase Auth user first.

## Implementation note

Drizzle does not manage the auth schema, and declaring a cross-schema foreign key
in the schema file would make drizzle-kit attempt to create auth.users itself.

The constraint is therefore appended to the migration as hand-written SQL. This
is recorded here because it is invisible in the schema file and would otherwise
look like an omission.

---

# Decision 4 — Password Encryption

## Decision

Netflix account passwords are encrypted at the application layer using
AES-256-GCM.

Column

accounts.password_encrypted

Module

lib/crypto

Key

ENCRYPTION_KEY, validated at boot alongside DATABASE_URL

## Why

03_DATABASE.md requires encrypted passwords and forbids exposing encrypted
values. The password must be recoverable, because the business sends it to
customers — so this is encryption, never hashing.

pgcrypto was rejected. Its key travels inside the SQL statement, which places it
in query logs and pg_stat_statements on a hosted database. Moving the key into
the application keeps it out of anything the database records.

Plaintext was rejected: it violates two LOCKED documents.

AES-256-GCM is authenticated encryption, so tampering with a stored value is
detected rather than silently decrypted into garbage.

## Consequence — an accepted conflict

01_MASTER_RULES.md requires global search across Password.

Encrypted values cannot be indexed or matched with SQL. Search by password
therefore requires decrypting candidate rows and filtering in application code.

This is accepted. Searching by password is a rare operation, and the alternative
is storing credentials in plaintext. The Search milestone must not assume an
indexed password lookup exists.

## Implementation note

Each ciphertext embeds its own random IV and authentication tag. Encrypting the
same password twice produces different output, which is correct and is also why
equality search on the column is impossible.

---

# Decision 5 — Repositories And Drizzle

## Context

ADR-003 states two rules that, taken literally, cannot both be satisfied.

Repositories

Forbidden: importing Drizzle.

Database Adapter

Forbidden: table-specific query building.

A repository must build queries for its table. Building a query requires the
schema and the query-builder operators. If the repository may not import Drizzle
and the Adapter may not build table-specific queries, no code may build a query
at all.

This went unnoticed in M01 and M01.5 because no repository existed. It surfaces
the moment one does.

## Decision

ADR-003's intent is preserved by reading the boundary as the connection, not the
query builder.

Repositories MAY import

drizzle-orm operators and types

@/lib/drizzle/schema

Repositories MAY NOT import

@/lib/drizzle/client

Only the Database Adapter holds the connection, owns transactions, applies the
retry policy, and translates driver errors.

## Why this preserves the intent

ADR-003 justified the Adapter as the single point where a PostgreSQL error can
enter the system and where an ORM swap is contained. Both still hold:

Every query executes through databaseAdapter.query or .transaction, so every
driver error is still translated in exactly one place.

No repository can obtain a connection, so no repository can bypass that
translation, the retry policy, or transaction scoping.

A repository describes what data it needs, expressed in the schema's vocabulary.
The Adapter still decides how it runs.

## Enforcement change

The ESLint rule for repositories previously blocked drizzle-orm and all of
@/lib/drizzle. It now blocks @/lib/drizzle/client specifically.

The rule that matters is enforced. The rule that was unimplementable is
corrected rather than quietly ignored.

## Status

This is a clarification of ADR-003, not a redesign. It is flagged explicitly for
the project owner because it relaxes a written rule.

---

# Decision 6 — Naming Clarifications

Two column names differ from 03_DATABASE.md.

## profiles.duration_days

03_DATABASE.md calls this subscription_duration, which does not state its unit.
CURRENT_MILESTONE.md calls it duration_days. The explicit unit is used, because a
duration column without a unit is a defect waiting to happen.

## accounts.subscription_type — OMITTED

CURRENT_MILESTONE.md lists it. 03_DATABASE.md does not, and no document defines
its permitted values.

01_MASTER_RULES.md forbids inventing business rules, so the column is not
created. It requires a decision on its value set before it can exist.

---

# Final Decision

These decisions are adopted. Changing any requires a new ADR and approval from
the project owner.

---

END OF ADR-005
