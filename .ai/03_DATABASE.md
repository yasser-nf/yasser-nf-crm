# Yasser NF CRM
# DATABASE DESIGN

Version: 1.1
Status: LOCKED

---

# IMPLEMENTATION STATUS

See ADR-005.

Implemented in M02

users

customers

accounts

profiles

profile_events

audit_logs

backups

settings

Deferred to later milestones

orders

issues

timeline_events

notifications

Two consequences of the deferral:

profiles.current_order_id is not created. A foreign key cannot reference a table
that does not exist. It arrives with orders.

01_MASTER_RULES.md requires every account to own a timeline. That requirement is
NOT yet satisfied. profile_events covers profile grain only.

New table not described below

profile_events

Profile-level history. Distinct from timeline_events, which is account grain.
Specified in ADR-005.

---

# PURPOSE

This document defines the complete database architecture of Yasser NF CRM.

It specifies:

- Database philosophy
- Naming conventions
- Tables
- Relationships
- Constraints
- Indexes
- Enums
- Triggers
- Security
- Row Level Security
- Audit Strategy
- Migration Strategy

No implementation may violate this document.

---

# DATABASE ENGINE

PostgreSQL

Hosted by Supabase.

Schema management through Drizzle ORM.

---

# DATABASE PHILOSOPHY

The database is the single source of truth.

Never duplicate business data.

Normalize everything.

Store relationships, not repeated information.

Every table must have a single responsibility.

---

# NAMING RULES

Tables

Plural

Examples

accounts

profiles

customers

orders

issues

---

Columns

snake_case

Examples

created_at

updated_at

customer_id

profile_number

---

Primary Keys

Always

id

UUID

---

Foreign Keys

table_id

Examples

account_id

customer_id

worker_id

---

Timestamps

Every table contains

created_at

updated_at

Unless there is a strong reason not to.

---

# TABLES

The system consists of:

accounts

profiles

customers

orders

users

issues

timeline_events

audit_logs

notifications

backups

settings

---

# TABLE
accounts

Purpose

Represents one Netflix account.

Columns

id

email

password_encrypted

status

health_score

country

notes

created_by

created_at

updated_at

archived_at

deleted_at

Business Rules

Exactly one account.

Always contains five profiles.

Health score between 0 and 100.

Only one active record per email.

Unique email.

---

# TABLE
profiles

Purpose

Represents one Netflix profile.

Columns

id

account_id

profile_number

pin

status

customer_id

current_order_id

sale_date

expiration_date

subscription_duration

worker_id

notes

created_at

updated_at

Rules

Exactly five profiles belong to one account.

Allowed profile numbers:

1

2

3

4

5

Unique

(account_id, profile_number)

---

# TABLE
customers

Purpose

Represents a customer.

Columns

id

name

phone_original

phone_normalized

whatsapp_url

notes

first_purchase_at

last_purchase_at

created_at

updated_at

Rules

phone_normalized

must be unique.

---

# TABLE
orders

Purpose

Represents a sale.

Columns

id

customer_id

profile_id

worker_id

duration

sale_date

expiration_date

status

notes

created_at

updated_at

Orders are immutable.

Never overwrite history.

---

# TABLE
users

Purpose

CRM users.

Columns

id

name

email

role

status

last_login_at

created_at

updated_at

deleted_at

Identity

id references auth.users(id) ON DELETE CASCADE.

Supabase Auth owns credentials. There is no password column of any kind in this
table. See ADR-005 Decision 3.

This table is the authoritative location for role, resolving the deferral
recorded in ADR-003.

---

# TABLE
issues

Purpose

Represents account problems.

Columns

id

account_id

issue_type

status

reported_by

resolved_by

description

reported_at

resolved_at

Rules

Issues belong to Accounts.

Never Profiles.

---

# TABLE
timeline_events

Purpose

Account history.

Examples

Account Created

Password Changed

Profile Sold

Payment Problem

Recovered

Archived

Every important action creates a timeline event.

Timeline never loses history.

---

# TABLE
audit_logs

Purpose

Immutable system log.

Stores

who

did what

when

where

Never editable.

Never deletable.

---

# TABLE
notifications

Purpose

User notifications.

Supports

Info

Success

Warning

Danger

Unread

Read

---

# TABLE
backups

Purpose

Tracks backups.

Columns

type

status

checksum

created_by

created_at

restore_point

---

# TABLE
settings

Global application settings.

One row only.

---

# ENUMS

Account Status

Healthy

Payment Problem

Incorrect Password

Invalid Email

Something Went Wrong

Archived

Deleted

---

Profile Status

Available

Reserved

Sold

Expiring Soon

Expired

---

Issue Type

Payment Problem

Incorrect Password

Invalid Email

Something Went Wrong

Other

---

User Role

Super Admin

Worker

---

Notification Type

Info

Success

Warning

Danger

---

# RELATIONSHIPS

accounts

↓

profiles

(1 → 5)

---

profiles

↓

orders

(1 → many)

---

customers

↓

orders

(1 → many)

---

accounts

↓

issues

(1 → many)

---

accounts

↓

timeline_events

(1 → many)

---

users

↓

orders

(1 → many)

---

users

↓

audit_logs

(1 → many)

---

# INDEXES

Create indexes for

email

phone_normalized

status

expiration_date

created_at

worker_id

customer_id

account_id

Search performance has priority.

---

# CONSTRAINTS

Unique

accounts.email

customers.phone_normalized

(account_id, profile_number)

---

Check

health_score between 0 and 100

profile_number between 1 and 5

---

Foreign Keys

All relationships enforced.

---

# BUSINESS RULES

One Account

↓

Five Profiles

Only.

---

Unhealthy Account

↓

All Profiles unavailable.

---

Expired Profile

↓

Automatically Available

if account is Healthy.

---

Orders

Never deleted.

Never modified.

---

Timeline

Never modified.

---

Audit Logs

Never modified.

---

# SMART PHONE ENGINE

Input

+213 663 94 71 16

↓

Normalize

663947116

↓

Generate

https://wa.me/213663947116

Always store

Original

Normalized

URL

---

# SMART STOCK ENGINE

Score calculated using

Health

Availability

Problem History

Distribution

Recent Usage

Returns highest score.

---

# BACKUP STRATEGY

Hourly

Daily

Manual

Restore Point

Checksum Verification

---

# SECURITY

Encrypt passwords.

Never expose encrypted values.

Method

AES-256-GCM at the application layer, in lib/crypto. Key in ENCRYPTION_KEY,
validated at boot. Never pgcrypto — its key would travel inside SQL statements
and reach query logs. See ADR-005 Decision 4.

Accepted conflict

01_MASTER_RULES.md requires search across Password. Encrypted values cannot be
indexed or matched in SQL, so search by password requires decrypting candidates
in application code. The Search milestone must not assume an indexed lookup.

Enable RLS on all business tables.

Every query must respect permissions.

---

# MIGRATION

Google Sheets

↓

Validation

↓

Import

↓

Accounts

↓

Profiles

↓

Customers

↓

Orders

↓

Timeline

↓

Audit

Migration is one-time only.

---

# FUTURE COMPATIBILITY

The schema must support:

100,000+ accounts

500,000+ profiles

Millions of orders

Without redesign.

---

# END

This database specification is LOCKED.

All migrations must comply with this document.