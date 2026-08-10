# ADR-009
# Backup And Restore Decisions

Status: ACCEPTED

Date: 2026-08-10

Owner: Yasser Saidi

Amends: 01_MASTER_RULES.md, 02_ARCHITECTURE.md, 03_DATABASE.md, ADR-001

---

# Context

Milestone M07 builds the Backup & Restore system.

Preparing it surfaced questions that no document answered, and one conflict
between documents that are all marked LOCKED. Per 05_DEVELOPMENT_WORKFLOW.md the
work stopped and all five decisions below were put to the project owner and
approved on 2026-08-10.

---

# Decision 1 — Artifacts Live In Supabase Storage

## Decision

Backup artifacts are gzipped JSON objects in a private Supabase Storage bucket
named `backups`.

The `backups` table stores metadata and points at the object.

## Why

No document specified where a backup file lives. ADR-001 deploys to Vercel,
which has no persistent filesystem, so writing to disk was never available.

Storing multi-megabyte compressed dumps inside PostgreSQL was rejected: it would
bloat the database this module exists to protect, and every read would load the
whole artifact into memory.

Supabase Storage was already part of the adopted stack — ADR-001 lists it — so
this adds no new technology.

## Security

The bucket is private and reached only with the service role key, under ADR-008
Decision 4. There is no public URL at any point.

A CRM dump contains every customer phone number and every encrypted account
credential in the system. A leaked link would be a full breach, so export issues
a signed URL valid for sixty seconds rather than making an object readable.

---

# Decision 2 — The Schedule Is Stored, Not Executed

## Decision

M07 stores the backup schedule and retention policy in settings, and reports
what is due. Nothing fires automatically.

## Why

"Automatic Backup" requires an execution mechanism, and no document defines one.
Three were considered:

Vercel Cron calling a protected route

pg_cron inside Supabase

no automatic execution

The project owner chose the third for M07. Vercel Cron would have required a
Route Handler, which 02_ARCHITECTURE.md and ADR-006 Decision 3 exclude from the
app directory; pg_cron would have put backup logic in SQL, duplicating the
services and violating 01_MASTER_RULES.md's rule against duplicated business
logic.

## Consequence

This is recorded as INCOMPLETE, not as done. The scheduler UI shows what is due
and a Super Admin presses the button.

`snapshotService.isDue` exists and is unit tested. It is the function a cron
entry will call once a trigger is chosen, so adopting one later is wiring rather
than design.

---

# Decision 3 — Backup Frequencies Are The Union Of Both Sources

## Context

Four LOCKED documents require an hourly backup:

01_MASTER_RULES.md (priority 1)

ADR-001 (priority 2)

02_ARCHITECTURE.md

03_DATABASE.md

The M07 brief omits hourly and adds weekly and monthly.

The priority order in 05_DEVELOPMENT_WORKFLOW.md cannot resolve this: the
conflict is between the standing documents and a new instruction, not between
two documents.

## Decision

`backup_type` is:

hourly · daily · weekly · monthly · manual · snapshot

Both sets are kept. Nothing already written becomes wrong, and the new
frequencies are available.

## Rejected

Following the brief exactly. It would have required overriding a rank-1 LOCKED
document to remove a capability nobody asked to remove.

## Note on `automatic`

There is no `automatic` value. "Automatic" describes the four scheduled
frequencies as a group, not a fifth kind of backup. Storing it would make the
frequency unknowable after the fact.

---

# Decision 4 — Orphaned Users Are Skipped, Not Fatal

## Context

`public.users.id` references `auth.users(id)`. A backed-up user whose Supabase
Auth identity has since been deleted cannot be inserted at all.

The brief also requires all-or-nothing restore.

## Decision

Restore only users whose `auth.users` identity still exists.

For a missing identity:

skip that user

report it in the Restore Preview

mark it an orphan

continue restoring every other entity

The restore stays atomic for all valid entities. A detailed orphan report is
produced at the end.

## Why

The strict reading — abort everything — would make one deleted Auth identity
permanently destroy the usefulness of an otherwise good backup, during exactly
the incident the backup exists for.

## Consequence

Rows elsewhere that reference a skipped user would violate their foreign key.
Those columns are nullable, so the reference is set to null and every instance
is counted in the orphan report. Dropping the referencing row instead would lose
an account or an audit entry to fix a user problem.

---

# Decision 5 — Immutable Tables Are Append-Only On Restore

## Decision

Restore treats tables differently by policy.

reconcile

users · customers · accounts · profiles · settings

Create, update and delete, so the table matches the backup exactly.

append_only

audit_logs · profile_events

Create missing rows only. Never update, never delete.

## Why

01_MASTER_RULES.md: audit logs are immutable, never deleted, never modified.

A restore that reconciled them would delete every event recorded since the
backup was taken — precisely the history an incident investigation needs, and
the rule exists to prevent exactly that deletion.

## Consequence

After restoring an old backup, the audit log is a superset of what the backup
contained. The preview states this explicitly as a warning rather than leaving
the operator to discover it.

## Excluded from backup entirely

auth.sessions — the brief excludes sessions outright

login_history — authentication telemetry tied to sessions

backups — a backup containing the backup catalogue would, on restore, delete
every backup taken since, including itself

---

# Decision 6 — Backup Settings Stay In jsonb

## Decision

The schedule and retention policy live inside `settings.values`, validated by a
Zod schema at the application boundary.

## Why

The schema comment on `settings` says specified settings should be promoted to
typed columns. These are the first two settings the project has ever specified,
and a typed column per preference in a singleton table would mean a migration
every time a default changes.

The Zod schema gives the same guarantees at the point the value is read and
written, which is the only place it is used.

## Status

Flagged explicitly because it declines a written recommendation. If settings
grow beyond this module, promotion should be revisited.

---

# Final Decision

These decisions are adopted. Changing any requires a new ADR and approval from
the project owner.

---

END OF ADR-009
