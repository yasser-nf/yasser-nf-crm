# Backup Module

Version: 2.0 · Milestone: M07 (evolves the module from ADR-009; nothing was replaced wholesale)

---

## 0. Status at a glance

| | |
| --- | --- |
| **Implemented now** | Manual backups and snapshots · consistent snapshot reads · format v2 with a content hash · verify · import · export (signed URL) · preview with a full **rehearsal** · typed-confirmation restore, atomic, with safety snapshot and restore lock · retention with safety floors · the scheduler logic and its authenticated endpoint · Super Admin only · audit of every step |
| **Requires deployment / infrastructure** | Automatic backups FIRE only once (1) `CRON_SECRET` is set on the Vercel project and (2) something calls `GET /api/cron/backups` on a schedule — see §7. Until then the page says "Not running". |
| **Deferred** | See §12 |

---

## 1. Audit of what existed before M07

| Existed | Kept | Changed in M07 |
| --- | --- | --- |
| Streaming gzip artifact to a private Supabase bucket | ✓ | Written inside one REPEATABLE READ snapshot; format v2 |
| SHA-256 of the stored file, verify, constant-time compare | ✓ | Plus a content hash inside the file |
| 7 tables captured | — | **11**: `issues`, `issue_notes`, `notifications`, `report_presets` were not backed up at all |
| Preview (row diff) before restore | ✓ | Plus validation and a rehearsal measuring every effect, cascades included |
| One-transaction restore, safety snapshot | ✓ | Snapshot taken after validation (a corrupt file no longer costs one); typed confirmation bound to the previewed checksum; restore lock |
| Retention keep-last-N, restore points/snapshots protected | ✓ | Restored-from backups become restore points; nothing pruned during a restore |
| Schedule settings, `isDue` | settings ✓ | Slot-based scheduler + endpoint; `isDue` left for compatibility |
| Failure reason = raw error message | — | Stored through the M06 scrubber |

Defects found and fixed:

- **Tables missing from an older backup were emptied on restore.** The apply loop treated an
  absent table as "keep no rows". A v1 backup restored after M03 would have deleted every problem.
  Absent tables are now left alone; only what the database cascades goes, and the rehearsal shows
  exactly how much.
- **Backups could be inconsistent.** Each 500-row page of each table was its own query.
- **Silent side effects.** `profile_events` (append-only) cascades from `accounts`/`profiles`, and
  deleting users clears links in `audit_logs`; neither was reported. The rehearsal now measures both.
- **Orphan handling** allowed references to users that the restore itself deletes; now only
  restorable backup users are valid targets.

---

## 2. What is captured

In dependency order — inserts run forward, deletes in reverse.

| Table | Restore policy |
| --- | --- |
| `users` | reconcile |
| `customers` | reconcile |
| `accounts` | reconcile |
| `profiles` | reconcile |
| `profile_events` | append-only |
| `issues` | reconcile |
| `issue_notes` | append-only |
| `notifications` | reconcile |
| `report_presets` | reconcile |
| `audit_logs` | append-only |
| `settings` | reconcile |

**Excluded, deliberately:** `auth.*` (Supabase Auth identities and credentials — a restore cannot
recreate an Auth identity; see the orphan rule), `login_history` (session telemetry), `backups` (the
catalogue: restoring it would delete every backup taken since, including the safety snapshot).
A test compares this list with the database catalogue, so a new table fails the suite until it is
classified.

**Never in a backup:** environment variables, `ENCRYPTION_KEY`, database credentials, the service
role key, `CRON_SECRET`, tokens, cookies, sessions. Account passwords are present **only as the
stored AES-256-GCM ciphertext** (`lib/crypto` is never called by backup or restore); profile PINs are
present as stored business data. Tested.

---

## 3. Format

gzipped JSON: `{"manifest":{…},"data":{"<table>":[rows…],…},"rowCounts":{…},"contentSha256":"…"}`
(counts and hash are written last because they are known last; readers fold them into the manifest).

| Field | |
| --- | --- |
| `formatVersion` | 2 (1 = pre-M07, still restorable, with a warning) |
| `schemaVersion` | migrations applied when taken; a backup from a newer schema is refused |
| `createdAt`, `createdBy`, `appVersion`, `databaseVersion`, `type`, `tables` | metadata |
| `contentSha256` | SHA-256 of the data under canonical serialisation — required in v2 |

Rows come from `to_jsonb(row)` (PostgreSQL does the type conversion), ordered by `id`; tables in the
fixed order above; `null` is explicit.

**Content hash, exactly** — any SHA-256 tool can reproduce it: for each table in `tables` order,
the line `table:<name>\n`, then for each row `canonicalJson(row) + "\n"`, where canonical JSON sorts
object keys at every depth and keeps array order (`backup-format.ts`, `contentLines`). It never
depends on key order, JavaScript insertion order or the gzip output.

---

## 4. Consistency

The whole artifact is read inside **one** `databaseAdapter.readSnapshot` transaction:
`REPEATABLE READ, READ ONLY`. Every page of every table sees the database at the instant of the
first query, whatever commits meanwhile. Read-only, it takes no write locks and cannot fail on
serialisation. The gzip stream is created inside the transaction callback so an adapter retry starts
from a clean stream.

---

## 5. Integrity

| Check | Where |
| --- | --- |
| File SHA-256 vs catalogue row | verify, preview, restore |
| Content hash vs data (v2) | verify, import, preview, restore |
| Structure: tables ↔ manifest, row counts, uuid ids, duplicates, **every relationship between backed-up tables resolves inside the backup** | import, preview, restore |
| Current schema: required columns present, enum values allowed | preview, restore |
| Everything else the database enforces (types, unique indexes, checks, FKs to non-backed-up rows) | the rehearsal |

A corrupted or malformed backup is refused before any write — and before a safety snapshot is taken.

---

## 6. Restore

```
download → file checksum → parse + compatibility → content hash → structure → schema
PREVIEW:  row diff + REHEARSAL (the real apply, in a transaction that is always rolled back,
          measuring every public table before/after and every link cleared)
CONFIRM:  type RESTORE; the request carries the previewed file's checksum
RESTORE:  same validation again → audit restore_started → target marked restore point
          → safety snapshot (no snapshot, no restore) → ONE transaction holding the restore
          advisory lock: deletes children-first, upserts parents-first → commit, or nothing
          → audit restored / restore_failed
```

- **Atomic by construction**: the adapter's transaction rolls back on any throw. Tested with a backup
  the database rejects (duplicate unique key): rehearsal refused, restore rolled back, business data
  identical.
- **Only what was previewed**: a different checksum is a conflict.
- **One at a time**: `pg_try_advisory_xact_lock`; a second restore is refused, and retention does not
  delete while a restore holds the lock.
- **Orphans**: a backed-up user without an Auth identity is skipped; nullable references to it are
  cleared, rows that require it (a notification's recipient, a report preset's owner) are skipped;
  all counted.
- **Columns**: only the columns a backup carries are inserted, so columns added since take their
  defaults.

### Evidence that a restore happened

`restore_started` is written before the apply and `restored` / `restore_failed` after it. Because
`audit_logs` is append-only in a restore — rows not in the backup are kept — the restore never erases
its own record. The safety snapshot lives in `backups`, which is never restored.

---

## 7. Automatic backups — endpoint implemented, trigger required

`GET /api/cron/backups`, outside the login redirect, guarded by `Authorization: Bearer <CRON_SECRET>`
(constant-time). No `CRON_SECRET` → **503** (off). Wrong bearer → 401.

Each call is one tick: fail backups still `running` after 30 minutes (their process is gone); stand
down if a backup is running; otherwise run one if due. **Slots, not intervals**, all UTC:
hourly = each hour; daily = `hourUtc`:00; weekly = Mondays `hourUtc`:00; monthly = the 1st at
`hourUtc`:00. Due = no successful scheduled backup since the latest slot. So any calling frequency is
safe; a missed slot self-heals with one backup. Two triggers in the same instant could at worst make
one extra backup, pruned like any other.

Configuration: Settings → Backups (`frequency`, `hourUtc`, `keepLast`), as before.

**To make it operational (deployment phase):**

1. Set `CRON_SECRET` (≥ 32 chars) on the Vercel project.
2. Add a trigger. The project is on the **Vercel Hobby plan: Vercel Cron runs at most once a day**
   (and not at a precise minute), which serves `daily`, `weekly` and `monthly`:
   ```json
   "crons": [{ "path": "/api/cron/backups", "schedule": "0 2 * * *" }]
   ```
   `hourly` needs a Pro plan cron or an external scheduler calling the endpoint hourly with the bearer.

Until both are in place, the Backups page shows "Not running" for a configured schedule.

---

## 8. Retention

Keep the last `keepLast` (1–365, default 30) successful routine backups, applied after each
successful backup. Never pruned and never counted: restore points (including every backup restored
from, and imports), snapshots (including every safety snapshot). Failed backups neither count nor
evict. `keepLast` below 1 or not a number is clamped — the newest successful backup always survives.
The row is deleted under the restore lock, then its file; each deletion is audited.

---

## 9. Security

| Control | Where |
| --- | --- |
| Super Admin only (`access_backups`), checked first in every public method | both services; Worker and signed-out tests |
| No browser path to payloads | no action returns backup data; export is a 60-second signed URL |
| RLS on `backups`, Super Admin policy; browser roles hold no grants | migration 0002, unchanged |
| Repositories, storage and the engine are not exported | `index.ts` exports only `backupScheduler.tick` |
| Dynamic table names checked against the allow-list, sent as identifiers | `dataset.repository.ts` |
| Failure reasons and logs through the M06 scrubber | `safeFailureReason`, `logger` |
| Audit entries carry metadata only — never the payload | tested |

---

## 10. Performance

Streaming write, 500 rows per page, one snapshot transaction, no N+1: a backup issues one page
query per 500 rows per table plus a handful of catalogue reads — about 30 queries for the production
dataset at M07 (~6,200 audit rows; the last production backup was 706 KB compressed). Peak memory is
one page plus the compressed output. Preview and restore hold the backup in memory
and run the apply twice (rehearsal, then real): fine at CRM scale; see §12 for the 500,000-profile
ceiling.

---

## 11. Failure behaviour

| Failure | Result |
| --- | --- |
| Backup write/upload fails | row `failed` with a safe reason; audited (`backup_failed`); logged safely; retention not run |
| Process dies mid-backup | row stays `running`; the next scheduler tick marks it failed |
| Corrupt/edited/incompatible backup | refused before any write, before any snapshot; `restore_failed` audited |
| Database rejects the data | rehearsal refuses the preview; a forced restore rolls back entirely |
| Safety snapshot fails | restore refused, nothing changed |
| Another restore running | refused (conflict) |

---

## 12. Deferred / limitations

- **Automatic backups are not operational** until `CRON_SECRET` and a trigger exist (§7).
- **Auth identities are not backed up** (Supabase Auth owns them); restoring after a user was deleted
  from Auth skips that user.
- **Storage is a single Supabase bucket in the same project** as the database: a project-wide loss
  loses both. Off-site copies (downloading exports, or a second destination) are an operational
  practice, not implemented.
- **Restore holds the backup in memory** and rehearses in full: fine now, not at the 500,000-profile
  ceiling in 02_ARCHITECTURE.md.
- **No manual delete** in the UI; deletion is retention only.
- **Restores against production have never been run**; they are proven against the isolated database.
