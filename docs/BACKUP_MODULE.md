# Backup Module

Version: 1.0
Milestone: M07

Authority: `.ai/` decides, this describes. Decisions in ADR-009.

---

## 1. Responsibilities

| Owns | Does not own |
| ---- | ------------ |
| Capturing business data as a portable artifact | The data itself — every table belongs to its own module |
| Integrity: SHA-256 generation and verification | Supabase's own platform backups |
| Restore preview and application | Session state — explicitly excluded |
| Retention | Scheduling execution — see §7 |
| Import and export | |

---

## 2. Architecture

```
app/(app)/backups/*            page composition only
  └── modules/backups (barrel)
        ├── components/        client rendering
        ├── actions/           network boundary (ADR-006 D3)
        ├── services/
        │     ├── backup.service.ts     create, verify, export, import, prune
        │     ├── restore.service.ts    preview and apply
        │     ├── snapshot.service.ts   system snapshots + isDue
        │     ├── checksum.service.ts   SHA-256            (pure, testable)
        │     ├── backup-format.ts      tables, order, policy (pure, testable)
        │     ├── retention.ts          what may be deleted  (pure, testable)
        │     └── artifact-writer.ts    streaming gzip writer
        ├── repositories/
        │     ├── backups.repository.ts  the catalogue
        │     └── dataset.repository.ts  the actual rows
        ├── storage/           Supabase Storage adapter
        └── validation/        Zod schemas
```

Repositories and the storage adapter are **not** exported. Both can read and
write every table in the system, so exposing either would offer a route past the
permission checks that make this module safe.

The four pure modules — checksum, format, retention, artifact ordering — carry no
`server-only` import, which is what makes them unit testable. Retention in
particular is the one place whose bugs *destroy* backups rather than merely
failing to create them, so it decides and never acts.

---

## 3. What Is Captured

In dependency order. **The order is load-bearing** — inserts run forward, deletes
run in reverse, so a parent always exists before its children.

| Table | Restore policy |
| ----- | -------------- |
| `users` | reconcile |
| `customers` | reconcile |
| `accounts` | reconcile |
| `profiles` | reconcile |
| `profile_events` | **append-only** |
| `audit_logs` | **append-only** |
| `settings` | reconcile |

`settings` carries both the audit configuration and the application
configuration the brief lists — they are values in the singleton row, not
separate tables.

### Excluded, deliberately

| Excluded | Why |
| -------- | --- |
| `auth.sessions` | The brief excludes sessions outright |
| `login_history` | Authentication telemetry tied to sessions |
| `backups` | A backup containing the catalogue would, on restore, delete every backup taken since — including itself |

### Why two policies

01_MASTER_RULES.md: audit logs are immutable, never deleted, never modified.

A restore that reconciled them would delete every event recorded since the backup
was taken — exactly the history an incident investigation needs. Append-only
tables gain missing rows and lose nothing. The preview says so explicitly rather
than letting the operator discover it afterwards.

---

## 4. Integrity

SHA-256 over the compressed artifact, using Node's `crypto` rather than a
dependency.

| Stage | What happens |
| ----- | ------------ |
| Create | Digest computed over the gzipped bytes, stored on the row |
| Verify | File re-downloaded, re-hashed, compared |
| Restore | **Verified again** before a single row is read |

`completed` and `verified` are different statuses on purpose. Completed means the
bytes were written. Verified means they were read back and still hash to what was
recorded. Treating those as the same is how an organisation discovers during an
incident that its backups were empty.

Comparison is constant-time (`timingSafeEqual`), with a length guard first
because that function throws on mismatched buffers.

A checksum mismatch **refuses the restore** and marks the backup failed.

---

## 5. Restore Flow

```
Preview  ← always first, never skippable
   ↓ download, verify checksum, parse, check compatibility
   ↓ diff every table against current state
   ↓ report: create / update / delete / warnings / conflicts / orphans
   ↓
Human reads it and confirms
   ↓
Snapshot of current data taken automatically
   ↓
Apply, inside ONE transaction
   ↓ deletes  — children first
   ↓ upserts  — parents first
   ↓
Commit, or roll back entirely
```

The M07 brief: never restore immediately. The confirm button does not exist until
a preview has been produced — a destructive action reachable in one click is a
destructive action taken by accident.

**Atomicity is structural, not careful.** The Database Adapter's transaction
helper rolls back on a thrown error, so a failure on the last table unwinds the
first. There is no partial restore to guard against.

A snapshot is taken before every restore. If the restore itself turns out to be
the wrong decision, that snapshot is the only way back — and it must exist before
the data is overwritten.

### Orphaned users

`public.users.id` references `auth.users(id)`. A backed-up user whose Auth
identity has since been deleted cannot be inserted.

ADR-009 Decision 4: skip that user, report it, restore everything else. Rows
elsewhere pointing at a skipped user have that nullable column set to `null`,
and every instance is counted — dropping the referencing row instead would lose
an account or an audit entry to fix a user problem.

---

## 6. Retention

Configurable, default **keep last 30**.

Never pruned, regardless of age or count:

- **Restore points** — a deliberate marker someone set
- **Snapshots** — the same intent, expressed as a type

Both are excluded from the count entirely rather than merely sorted last, so a
burst of snapshots cannot push out every routine backup.

Pruning deletes the storage object **before** the row. The other order strands an
orphaned object nobody can see and everyone pays for.

Retention runs after a successful backup, never before: pruning first could leave
fewer backups than the policy promises if the new one then failed.

A non-finite `keepLast` is clamped to the default. `Math.max(NaN, 1)` is `NaN`,
which turns `slice(0, limit)` into `slice(0, NaN)` — keeping nothing and pruning
every backup. The clamp alone looks sufficient and is not; a unit test pins it.

---

## 7. Scheduler — INCOMPLETE

ADR-009 Decision 2. The schedule and retention policy are stored in settings and
validated. **Nothing fires automatically.**

Supported frequencies: `off` · `hourly` · `daily` · `weekly` · `monthly`.

`hourly` survives from four LOCKED documents; `weekly` and `monthly` come from
the M07 brief. ADR-009 Decision 3 keeps both sets rather than overriding either.

`snapshotService.isDue` is implemented and unit tested. It is the function a cron
entry will call once a trigger mechanism is chosen, so adopting one is wiring
rather than design.

This is reported as unfinished, not as done.

---

## 8. Security

| Control | Where |
| ------- | ----- |
| Super Admin only, checked before every operation | both services |
| Workers have zero access | `ACCESS_BACKUPS` is absent from the Worker allow-list |
| RLS on `backups`, Super Admin policy | migration 0002, still asserted by tests |
| Private bucket, no public URL ever | `storage/backup-storage.ts` |
| Export via 60-second signed URL | same |
| Service role key `server-only` | ADR-008 Decision 4 |
| Table names checked against an allow-list before reaching SQL | `dataset.repository.ts` |
| Imported files validated before storage, stored before restore | `backup.service.ts` |

### Dynamic SQL

This module is the only place in the codebase where a table name is dynamic.
Two rules hold without exception: every name is checked against
`BACKUP_TABLE_NAMES` first, and identifiers go through `sql.identifier`, never
string interpolation. A backup module that concatenated a table name into SQL
would be a trivial injection point reachable from an uploaded file.

### What a backup contains

Every customer phone number and every encrypted account credential in the system.
It is the most sensitive artifact the CRM produces, which is why the bucket is
private, links expire in a minute, and only Super Admins can reach any of it.

Account passwords stay AES-256-GCM encrypted inside the backup — the artifact
carries the stored ciphertext, and `lib/crypto` is never invoked during backup or
restore. A leaked backup does not leak plaintext credentials unless
`ENCRYPTION_KEY` leaks with it.

---

## 9. Performance

Backups **stream on write**. Rows are read one page at a time (500) and pushed
straight into a gzip stream, respecting backpressure. Only one page and the
compressed output exist at once — the full uncompressed dataset is never
materialised.

Being precise about the limit: the compressed result **is** assembled into a
Buffer before upload, because the Supabase Storage client takes a body rather
than a Node stream. For a CRM dump that is a few megabytes. The part that would
actually exhaust memory — the uncompressed JSON — never exists.

Restore reads the artifact whole. It has to hold the dataset anyway to diff it
and apply it in one transaction, so streaming the read would save nothing and
complicate the atomicity that matters more.

`to_jsonb(row)` does the type conversion in PostgreSQL, and
`jsonb_populate_recordset` does it in reverse. Neither direction re-implements
type mapping in JavaScript, where one wrong timestamp or numeric silently
corrupts a backup.

---

## 10. Known Gaps

| Gap | Consequence |
| --- | ----------- |
| Scheduler does not execute | "Automatic Backup" is stored and reported, never fired |
| Restore never applied against the live database | Preview, checksum refusal and rollback structure are verified; the apply path is not — see the M07 report |
| Preview loads current rows per table to diff | Fine at CRM scale, not at the 500,000-profile ceiling in 02_ARCHITECTURE.md |
| Retention prunes only after a successful backup | A system that stops backing up also stops pruning |
| No backup of `login_history` or sessions | Intentional; recorded here so it is not mistaken for an oversight |
