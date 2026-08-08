# ADR-006
# Account Module Decisions

Status: ACCEPTED

Date: 2026-08-08

Owner: Yasser Saidi

Amends: 03_DATABASE.md, 02_ARCHITECTURE.md, ADR-005

---

# Context

Milestone M03 builds Account and Profile management. Its brief requires four
things that change decisions recorded in earlier documents.

---

# Decision 1 — timeline_events Is Cancelled

## Decision

timeline_events will never be built.

profile_events is the only event source. Account history is produced by querying
profile_events by account_id.

## Why

01_MASTER_RULES.md requires every account to own a timeline. ADR-005 recorded
that requirement as outstanding, because 03_DATABASE.md specified a separate
timeline_events table that M02 deferred.

The M03 brief resolves it differently: one event table, queried at two grains.

Two tables recording overlapping history would duplicate information, which
03_DATABASE.md forbids. Every account-level event worth showing a user is
already an event about one of its five profiles, or a field change captured by
audit_logs.

## Consequence

The outstanding timeline requirement from ADR-005 is now CLOSED, not deferred.

03_DATABASE.md's timeline_events section is superseded.

Account history has two sources with different jobs:

profile_events

What happened to the profiles. Shown as the account timeline.

audit_logs

What changed on the account record itself: email, status, notes, password.

---

# Decision 2 — profile_events Gains account_id

## Decision

profile_events.account_id, NOT NULL, references accounts(id) ON DELETE CASCADE.

Two columns are renamed to match the M03 brief and the existing audit_logs
convention:

data → metadata

actor_user_id → user_id

## Why the denormalisation is justified

account_id is derivable through profiles.account_id, so this duplicates a
relationship. 03_DATABASE.md permits that only with architectural justification.

The justification is the read pattern Decision 1 creates. Account history is now
a primary screen, and without this column every load joins profile_events to
profiles to filter by account. Against the scale 02_ARCHITECTURE.md requires —
500,000 profiles and millions of events — that join runs on every account page
view.

With the column and a composite index on (account_id, created_at DESC), the
query reads one index range.

The duplicated value is also immutable: a profile never moves between accounts,
and profiles.account_id has no update path anywhere in the codebase. The usual
danger of denormalisation, that the copy drifts from the source, cannot occur
here.

## Why NOT NULL

A nullable account_id would make the account timeline silently incomplete. Every
event belongs to a profile, and every profile belongs to an account, so the value
always exists.

## Consequence

Migration 0002 adds the column. The rename is free because no database has ever
been provisioned and the table has never held a row.

---

# Decision 3 — Server Actions Are The Transport Layer

## Context

02_ARCHITECTURE.md lists a module's folders: components, hooks, services, types,
utils, validation, pages. Repositories were added by ADR-003.

Repositories and services are server-only — they import the database. Client
components cannot call them directly, so something must cross the boundary.

## Decision

Modules gain an actions/ folder holding Next.js Server Actions.

React Component

↓

Hook (TanStack Query)

↓

Server Action  ← the network boundary

↓

Service

↓

Repository

↓

Database Adapter

## Why not Route Handlers

app/api/ route handlers would work, but 02_ARCHITECTURE.md states the app
directory holds layouts, routes, providers and page composition — nothing else.
Putting a feature's transport there would scatter one module across two trees and
weaken the removability test in ADR-003 Rule 5.

Server Actions keep the module self-contained: deleting modules/accounts/ removes
its transport with it.

## Rules

An action contains no business logic. It validates input, resolves the current
user, calls one service method, and returns.

An action never returns a decrypted password unless that is its entire purpose.

Actions are the only module files a client component may reach through.

---

# Decision 4 — Passwords Are Revealed On Request

## Context

The M03 brief requires the account details page to display the password, and
also states that decrypted passwords must never be sent unless explicitly
required by the page.

## Decision

The account details payload does NOT contain the password.

A separate action decrypts and returns it, called only when a person clicks to
reveal it.

## Why

Including it in the page payload would place every account password in the
server-rendered HTML, in the browser's memory, and in any client-side cache — for
every visit, whether or not anyone wanted to see it.

Reveal-on-request means the plaintext exists only in the response to a deliberate
human action.

It also produces a natural audit boundary: revealing a credential is an event
worth recording, and it cannot be recorded if it happens implicitly on page load.

## Consequence

The page shows a masked field with a reveal control. The brief's requirement to
display the password is met; the requirement not to send it unnecessarily is met
as well.

---

# Final Decision

These decisions are adopted. Changing any requires a new ADR and approval from
the project owner.

---

END OF ADR-006
