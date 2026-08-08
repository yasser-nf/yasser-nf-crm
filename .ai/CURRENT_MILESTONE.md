# Yasser NF CRM

# CURRENT MILESTONE

Milestone: M02

Name

Database Foundation

Status

READY TO START

Priority

Critical

---

# GOAL

Design and implement the complete database architecture for Yasser NF CRM.

This milestone creates the production-ready data model.

No business UI.

No CRM screens.

No dashboard features.

Only the database, repositories and domain models.

---

# OBJECTIVES

Create a fully normalized PostgreSQL schema.

Use Drizzle ORM.

Create all migrations.

Create repositories.

Create database adapters.

Create indexes.

Create constraints.

Create relations.

Create enums.

Create seed infrastructure.

Everything must be production-ready.

---

# INCLUDED

Database schema

Enums

Relations

Indexes

Constraints

Foreign Keys

Repositories

Database Adapter

Transaction helper

Seed system

Migration system

Repository interfaces

Repository implementations

Domain models

Validation schemas

---

# NOT INCLUDED

Dashboard

Accounts page

Customers page

Reports

Search

Quick Prepare

Problems Engine

Notifications

Backups

Business logic

UI features

---

# DATABASE ENTITIES

The following entities must be implemented.

## Users

Purpose

CRM users.

CORRECTED by ADR-005 Decision 3.

password_hash is NOT created. ADR-001 adopted Supabase Auth, which already stores
credentials in auth.users. A second credential store would contradict that ADR
and 03_DATABASE.md's rule against duplicating data.

Fields

- id  (references auth.users(id) ON DELETE CASCADE)
- name
- email
- role
- status
- last_login_at
- created_at
- updated_at
- deleted_at

---

## Customers

Purpose

Netflix buyers.

Fields

- id
- phone
- whatsapp
- normalized_phone
- notes
- created_at
- updated_at

---

## Accounts

Purpose

Netflix accounts.

Fields

- id
- email
- password
- status
- problem
- note
- country
- subscription_type
- created_at
- updated_at

---

## Profiles

Purpose

Netflix profiles.

Fields

- id
- account_id
- profile_number
- profile_name
- pin
- status
- current_customer_id
- sale_date
- duration_days
- expiration_date
- created_at
- updated_at

---

## Orders — DEFERRED

NOT created in M02. See ADR-005 Decision 1.

The project owner scoped M02 without orders. An orders table with no sale flow
would require altering the moment that flow existed, and every migration against
a live database carries risk an unused table does not justify.

Consequence: profiles.current_order_id is not created either.

When orders arrive they must never be deleted or modified.

---

## Profile Events

Purpose

Profile-level history. Immutable.

Fields

- id
- profile_id
- event_type
- actor_user_id
- customer_id
- data (jsonb, for forward extensibility)
- notes
- created_at

Distinct from timeline_events, which is account grain and still deferred.

---

## Audit Logs

Purpose

Track every modification.

Fields

- id
- entity
- entity_id
- action
- before
- after
- user_id
- created_at

Immutable.

---

## Backup Metadata

Purpose

Track backup operations.

Fields

- id
- filename
- size
- checksum
- created_at

---

# ENUMS

CORRECTED by ADR-005 Decision 2.

The lists previously in this section contradicted both 01_MASTER_RULES.md and
03_DATABASE.md, which are ranked above this document by
05_DEVELOPMENT_WORKFLOW.md and which agree with each other. They were rejected.

Authoritative enums

user_role

super_admin

worker

account_status

healthy

payment_problem

incorrect_password

invalid_email

something_went_wrong

archived

deleted

profile_status

available

reserved

sold

expiring_soon

expired

Rejected

AccountStatus of Available / Full / Problem / Disabled.

A separate ProblemType enum — it would duplicate account_status.

profile_status containing Problem instead of Expiring Soon.

A role named Admin — config/roles.ts already implements super_admin.

OrderSource — deferred with orders.

Additional enums created in M02

user_status · profile_event_type · audit_action · audit_entity ·
backup_type · backup_status

---

# RELATIONS

Account

↓

Profiles (1:N)

Customer

↓

Orders (1:N)

Profile

↓

Orders (1:N)

User

↓

Audit Logs (1:N)

---

# INDEXES

Create indexes for

email

phone

normalized_phone

expiration_date

status

problem

profile_number

created_at

sale_date

---

# REPOSITORIES

Create

AccountsRepository

ProfilesRepository

CustomersRepository

OrdersRepository

UsersRepository

AuditRepository

BackupRepository

Repositories must expose interfaces.

Implementations must remain private.

---

# DATABASE ADAPTER

Implement

Connection

Transactions

Error Translation

Retry Policy

Typed Results

---

# VALIDATION

Create Zod schemas for every entity.

Create insert schemas.

Create update schemas.

Create select schemas.

---

# MIGRATIONS

Generate initial migration.

Migration must be reversible.

---

# SEEDING

Create seed infrastructure.

No fake production data.

Only sample development data.

---

# ACCEPTANCE CRITERIA

Database compiles.

Migration executes.

Migration rollback executes.

Indexes exist.

Relations exist.

Repositories compile.

No any.

No TODO.

No duplicated code.

All entities documented.

---

# DELIVERABLES

Provide

Entity Diagram

Repository Diagram

Migration Summary

Tables Created

Indexes Created

Relations Created

Future Extension Points

---

# CLAUDE INSTRUCTIONS

Read every .ai document before implementing.

Do not invent business rules.

If any ambiguity appears,

STOP.

Ask before continuing.

---

# AFTER COMPLETION

Stop.

Wait for approval.

Do not begin M03.

END OF FILE