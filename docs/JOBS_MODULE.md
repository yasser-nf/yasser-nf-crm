# Jobs, queue and workflow idempotency (M08)

M08 adds the durable job foundation that M09's browser automation will run on, and hardens Quick
Prepare and Quick Replace against duplicate execution. This document starts with what the audit
found before any code changed (§1); the design follows.

---

## 1. Audit of the existing system (before M08)

### 1.1 Quick Prepare (`quickPrepareService.confirm`)

| Step | Where | Transaction |
| --- | --- | --- |
| Validate input (Zod) | service | — |
| Find or create the customer by phone | `customersService.findOrCreateByPhone` | its own (before) |
| Re-select stock **under lock** (`FOR UPDATE OF profiles SKIP LOCKED`) | `allocationRepository.lockCandidates` | **T1** |
| Duration rule, password-change gate (re-derived under lock) | service | T1 |
| Decrypt credentials (before any write — an undeliverable sale never commits) | service | T1 |
| Mark profiles sold, insert `sold` events, stamp customer purchase dates | service | T1 |
| Audit `quick_prepare_allocation` per account | `auditService.recordOrWarn` | after commit |

- **Synchronous, and right to be.** One transaction of a handful of statements; the result carries
  decrypted credentials the operator pastes into WhatsApp immediately. Nothing in it waits on an
  external system.
- **Atomic.** Everything that changes stock is T1. The audit is written only after commit, so a
  rolled-back sale leaves no "succeeded" trail. Locked rows are skipped, not waited for, so two
  concurrent sales take different profiles — never the same one.
- **NOT idempotent — the finding that matters.** Every call allocates afresh. Two calls with the same
  input sell two sets of profiles. Sources of a second call:
  1. a double click — the UI disables the button while pending, but a Server Action is a plain POST
     and nothing on the server recognises the repeat;
  2. a network retry by the browser or a proxy after the first request committed;
  3. **the database adapter itself**: `databaseAdapter.transaction` retries the whole transaction on
     connection errors (class 08, `ECONNRESET`, `CONNECTION_CLOSED`…). If the connection drops after
     PostgreSQL applied `COMMIT` but before the client saw it, the retry runs the allocation again and
     sells a second set of profiles. This is a real duplicate-sale path in production code.

### 1.2 Quick Replace (`quickPrepareService.confirmReplacement`)

| Step | Where | Transaction |
| --- | --- | --- |
| Validate; `stillHolds` pre-check (unlocked) | service | — |
| Read customer | repository | own |
| Lock the customer's held profiles (`FOR UPDATE`), re-verify they equal the previewed set | service | **T2** |
| Expired-allocation rule, approved replacement account still eligible (locked), duration covered | service | T2 |
| Password-change gate derived from the locked account; decrypt credentials | service | T2 |
| Release old profiles, `replaced/cancelled` events, sell new profiles, `replaced/reallocated` events | service | T2 |
| Audit `quick_prepare_replacement` (+ `password_change_confirmed`) | after commit | — |

- **Synchronous, atomic, and race-safe.** The held profiles are locked and compared with the preview
  inside T2, so a second replacement of the same allocation finds a different set and is refused.
  There is no double replacement.
- **But a repeat is an error, not a replay.** A double click or a network retry after the first
  commit gets "This allocation changed while you were reviewing it" — and the operator, whose first
  response was lost, never sees the replacement credentials. The adapter's retry-after-commit (1.1,
  point 3) produces the same refusal. No corruption; a bad outcome for the operator.

### 1.3 Jobs / queue infrastructure

None. No jobs table, no worker contract. The only background work is the M07 backup scheduler,
which is idempotent by slot design and is not touched by M08.

### 1.4 Other findings

- Customer creation (Quick Prepare) happens before T1 by design; a customer created for a sale that
  then fails is harmless and is found, not duplicated, on the next attempt (unique phone).
- Notifications are not part of either flow.
- The integration database (PGlite behind a socket multiplexer) runs **one transaction at a time**:
  while one client is inside a transaction, every other client's queries wait. Two "simultaneous"
  requests therefore execute one after the other. Tests can prove outcomes under that interleaving;
  row-lock contention itself (`SKIP LOCKED`, unique-index waits) rests on PostgreSQL semantics, as in
  M07.

### 1.5 Conclusions

| Operation | Stays synchronous? | Needs |
| --- | --- | --- |
| Quick Prepare confirm | yes — fast, credentials returned immediately | idempotency key, enforced in T1 |
| Quick Replace confirm | yes — same reasons | idempotency key, so a repeat replays instead of failing |
| Future automation (M09) | no — long-running, external | durable jobs: claim, heartbeat, retry, recovery |

---

## 2. What M08 adds

| Piece | Where | Purpose |
| --- | --- | --- |
| `jobs` table + `job_status` enum | migration `0015_jobs_queue` | the durable queue |
| `idempotency_keys` table | same migration | at-most-once business operations |
| `audit_entity` gains `job` | same migration | job lifecycle in the Logs |
| `@/modules/idempotency` | new module | `idempotency.operation / lookup / begin / complete / committed` |
| `@/modules/jobs` | new module | `jobQueue` (worker contract), `defineJob` / `createRegistry`, `jobsService` (Super Admin) |
| Quick Prepare / Quick Replace | `quick-prepare.service.ts` | a receipt claimed inside T1 / T2; replays |
| `/jobs` page | `src/app/(app)/jobs` | Super Admin operations view (`view_jobs`; cancel needs `manage_jobs`) |

The database is the source of truth for every job. Nothing is queued in memory, nothing is
scheduled with `setTimeout`, and nothing depends on a browser or a function staying alive.

---

## 3. Job lifecycle

```
            +------ retry / recover_requeue (attempts left, after backoff) -------+
            v                                                                      |
  enqueue -> queued --claim--> running --complete / recover_completed--> succeeded |
            |                    |  |                                              |
            |                    |  +--heartbeat (same owner)--> running           |
            |                    +---------------------------------------------------+
            |                    +--fail / recover_fail (permanent or exhausted)--> failed
            +--cancel (Super Admin)--> cancelled
```

| Cause | From → to | Who | Guard in the statement |
| --- | --- | --- | --- |
| claim | queued → running | a worker | `status='queued' AND available_at<=now() AND attempts<max_attempts`, row chosen `FOR UPDATE SKIP LOCKED` |
| heartbeat | running → running | the owner | `status='running' AND claim_token=$token` |
| complete | running → succeeded | the owner | same |
| retry (`fail` retryable, attempts left) | running → queued | the owner | same; `available_at = now() + backoff` |
| fail | running → failed | the owner | same |
| cancel | queued → cancelled | Super Admin | `status='queued'` |
| recover_requeue / recover_fail / recover_completed | running → queued / failed / succeeded | recovery | `status='running'`, heartbeat older than the threshold, row locked |

Nothing leaves `succeeded`, `failed` or `cancelled`. A running job is never "cancelled": its work may
already have committed. "Retrying" and "stale" are what the page shows, derived from the row
(`queued` with attempts > 0; `running` with a heartbeat older than 5 minutes) — not statuses.

Every transition is one `UPDATE … WHERE <from-state> [AND claim_token=…] RETURNING`. An invalid
transition matches no row and changes nothing; the service turns that into a refusal. The table's
check constraints hold the invariants for any writer:

- `jobs_running_has_owner` — running ⇒ claim token, worker, started_at, heartbeat_at
- `jobs_only_running_is_owned` — not running ⇒ no claim token
- `jobs_finished_iff_terminal`, `jobs_cancelled_iff_cancelled_at`
- `jobs_attempts_range` — 1 ≤ max_attempts ≤ 20, 0 ≤ attempts ≤ max_attempts
- `jobs_payload_object`, `jobs_payload_size` / `jobs_result_size` (≤ 8 KB), formats and lengths

## 4. Database model

`jobs`: `id`, `type`, `status`, `priority` (urgent 10 / normal 0 / low −10), `idempotency_key`
(unique with `type`), `payload` (references), `result` (safe metadata), `attempts`, `max_attempts`,
`available_at`, `started_at`, `heartbeat_at`, `finished_at`, `cancelled_at`, `claimed_by`,
`claim_token`, `last_error`, `last_error_code`, `recovered_at`, `created_by`, `created_at`,
`updated_at`.

| Index | Serves |
| --- | --- |
| `jobs_claim_idx (priority DESC, available_at, created_at, id) WHERE status='queued'` | the claim, in claim order (verified with `EXPLAIN` in the tests) |
| `jobs_running_heartbeat_idx (heartbeat_at) WHERE status='running'` | stale recovery |
| `jobs_type_idempotency_key_unique` | idempotent enqueue |
| `jobs_created_idx`, `jobs_status_created_idx`, `jobs_type_created_idx` | the jobs page and its filters |
| `jobs_created_by_idx` | the user foreign key |

`idempotency_keys`: primary key `(scope, key)`, `request_hash`, `actor_id`, `result` (references),
`created_at`.

Both tables are excluded from M07 backups (`EXCLUDED_TABLES`): restoring an old queue would re-run
work, and a receipt is meaningful only with the live rows it names.

## 5. Job types

A job type is a value created with `defineJob({ type, payload, maxAttempts?, priority?, receipt?, run })`.
There is no global registry: whoever enqueues passes the definition, and a worker process is given
the list it can run (`createRegistry([...])`). **M08 ships no production job type** — M09 adds the
first.

Payloads carry references. `enqueue` validates the payload with the type's schema, then refuses it
(writing nothing) if any key, at any depth, is sensitive by the audit module's own rule (`password`,
`pin`, `token`, `secret`, `key`…) or any value looks like an encrypted secret. A worker reads what it
needs from the records, server-side, when it runs. `complete`'s result is screened the same way.

## 6. Idempotency

### Primitive

```ts
const op = idempotency.operation(scope, key, actorId, request); // request hashed (canonical JSON)
const prior = await idempotency.lookup(op);                     // cheap pre-check, outside the transaction
if (prior.value) return replay(prior.value);
await databaseAdapter.transaction("…", async (tx) => {
  await idempotency.begin(tx, op);       // FIRST write: INSERT … ON CONFLICT DO NOTHING
  // … the business mutation …
  await idempotency.complete(tx, op, references);
});                                      // IdempotentReplay ⇒ replay the committed receipt
```

The receipt commits with the business rows or not at all. A repeat that arrives while the first is
still in its transaction waits on the primary key (PostgreSQL unique-index semantics), then finds the
committed row and replays; if the first rolled back, the repeat proceeds. A key reused by another
actor, or for a different request, is refused (`CONFLICT`) — never replayed.

### Keys

| Operation | Scope | Key | Request bound to the key |
| --- | --- | --- | --- |
| Quick Prepare | `quick_prepare.confirm` | the page's operation id: created once per reviewed order (when its preview arrives), sent with every attempt | profile count, duration, normalised phone, notes, password confirmation |
| Quick Replace | `quick_replace.confirm` | the page's operation id per (customer, replacement account, held profiles) | the same identifiers, the sorted held profile ids, reason, password confirmation |
| Server code without an id | same | a fresh UUID per call | — still makes the adapter's own retry safe |
| A job | the job type's `receipt()` | derived from the payload — e.g. the order's operation id | — |

The key identifies the **order**, not the HTTP request: a double click, a browser or proxy retry, and
a retry after a lost response all carry the same id. The Server Actions refuse a confirmation without
one ("This page is out of date. Reload it"), so a browser cannot opt out.

### Replay

A replay performs nothing: no allocation, no write, no audit. It reads the rows the receipt names
and requires them to still say what the receipt says — sold, to this customer, with this expiry. If
they do, the credentials are decrypted from the live records (the receipt never holds them) and the
original response is returned with `replayed: true` (the page says "Already prepared — showing its
result again"). If anything moved since, the replay is refused rather than hand over credentials
that no longer belong to the customer.

## 7. Worker contract (`jobQueue`)

| Call | Does | Ownership |
| --- | --- | --- |
| `enqueue(definition, { idempotencyKey, payload, priority?, availableAt? }, context, { permission? })` | creates the job once per (type, key); same key + same payload returns it; different payload → `CONFLICT` | optional permission required of the enqueuing actor |
| `claim(workerId, registry)` | next available job of the registry's types; returns `{ jobId, payload, attempt, claimToken, … }` | issues a fresh `claim_token` |
| `heartbeat(claim)` | extends the claim | token required; refusal ⇒ the claim is lost, stop |
| `complete(claim, result)` | → succeeded | token required; a repeat after a lost acknowledgement is harmless |
| `fail(claim, error)` | → queued (retryable, attempts left) or failed | token required |
| `retry(claim, reason)` | explicit retry (counts as an attempt) | token required |
| `recoverStale(registry, { staleAfterMs?, limit? })` | §9 | none — heartbeat age decides |
| `processNext(workerId, registry)` | reference loop body: claim, run with a heartbeat every 30 s, complete or fail; stops reporting if the claim is lost | — |
| `jobsService.cancel(id, context)` | queued → cancelled | Super Admin (`manage_jobs`) |

Worker A cannot touch worker B's job: every worker statement requires B's `claim_token`, which A does
not have. After recovery takes a job back, its old owner's token is void.

A claim whose acknowledgement is lost (the adapter retries the statement) leaves that first job
running with a token nobody holds; its heartbeat never starts, and recovery returns it to the queue.

## 8. Retries

`attempts` is incremented at claim time, so a crash still counts. Backoff before the next attempt:
30 s × 2^(attempt−1), capped at 15 minutes, computed in SQL (a test keeps it equal to
`retryDelaySeconds`). After `max_attempts` (default 3, at most 20) the job fails.

| Retried | Not retried |
| --- | --- |
| `JobRetryableError` (e.g. a worker timeout), `ExternalServiceError` | `ValidationError` (invalid payload, profile already sold…) |
| `DatabaseError` with a connection / serialisation / deadlock / shutdown SQLSTATE (08, 40001, 40P01, 57P0x, 53) | `ConflictError`, `NotFoundError`, `ForbiddenError`, `UnauthorizedError`, `ConfigurationError` |
| network errors (`ECONNRESET`, `ETIMEDOUT`, …) | constraint violations; any unexpected error (a handler defect) |

What is stored is the error **code** and the AppError's user-facing message — written to be shown,
never containing a bound value. An unexpected error stores a generic message. The technical detail
goes to the server log through the M06 path (`logger.error` → `toLogObject`, which scrubs bound
values). As everywhere in the application, a developer must not write a secret into an error
message: the log path scrubs query parameters, not arbitrary text.

## 9. Stale recovery

A job is stale when it is `running` and its heartbeat is older than 5 minutes (workers heartbeat
every 30 s). `recoverStale` locks stale rows with `SKIP LOCKED` (two recoveries divide the work) and
decides per job, **before** anything is retried:

1. Its type declares a receipt and the receipt has committed → the business operation already
   happened (the worker died after its transaction, before reporting) → **succeeded**, never re-run.
2. Otherwise, attempts remain → **queued** after the backoff, `last_error_code = JOB_STALE`.
3. Otherwise → **failed**.
4. A type the given registry does not know → **left untouched** (recovery cannot judge work it does
   not understand).

Every recovery is audited (`job_recovered`) and stamps `recovered_at`. Even if a requeued job's
operation did commit, its own idempotency replays on the next run — the receipt check is the first
line, the receipt claim inside the transaction the second.

## 10. Security

- **No browser path.** No Server Action or route creates, claims, heartbeats, completes, fails or
  retries a job. The only job action is `cancelJobAction`, checked against `manage_jobs`.
- **RLS.** `jobs` and `idempotency_keys`: grants revoked from `anon` and `authenticated`, RLS on, no
  policy. Tested: every select / insert / update / delete as either role is `permission denied`. The
  server's own connection is the only writer.
- **Super Admin only.** `view_jobs` (list, types, detail) and `manage_jobs` (cancel) are Super Admin
  permissions; Workers and signed-out users get `FORBIDDEN` before anything is read.
- **Browser payload.** A job reaches the page only as `JobListItem`: no payload, no result, no
  idempotency key, no claim token.
- **Errors.** §8 — code and safe message only.
- **Audit.** `entity = 'job'`: `create`, `job_succeeded`, `job_failed`, `job_cancelled`,
  `job_recovered`. The allow-list records lifecycle columns only — never `payload`, `result` or
  `claim_token`. Claims and heartbeats are not audited (they are on the row; auditing them would bury
  the log). Quick Prepare / Quick Replace audits are unchanged and written only on a real commit — a
  replay writes none.

## 11. Quick Prepare and Quick Replace

Both stay **synchronous**: one transaction of a handful of statements, no external I/O, and a result
(decrypted credentials) the operator needs at once. Making them jobs would mean storing those
credentials for later retrieval. The new primitive is used instead:

```
Quick Prepare:  validate → receipt pre-check → customer find/create →
                T1 [ receipt claim → lock stock (SKIP LOCKED) → duration + password gates →
                     decrypt → sell + events + customer dates → receipt result ] → audit
Quick Replace:  validate → receipt pre-check → stillHolds (re-checks the receipt before refusing) →
                T2 [ receipt claim → lock held profiles → re-verify preview → gates → lock target →
                     decrypt → release + sell + events → receipt result ] → audit
```

Unchanged business rules: eligibility (healthy, live, no blocking problem, still covered), slot
sellability, validity, password-change gate, approved-account binding, expiry carry-over.

## 12. Concurrency — tested, and what rests on PostgreSQL

The isolated test database is PGlite behind a socket multiplexer: **one transaction runs at a time**
and other connections wait. "Simultaneous" calls in the tests interleave at transaction boundaries.

| Guarantee | Evidence |
| --- | --- |
| Five workers claiming three jobs at once get three different jobs, three tokens | tested (interleaved) |
| Claim order: priority, availability, creation, id | tested; index use verified with `EXPLAIN` |
| Worker B cannot heartbeat / complete / fail A's job | tested |
| The same order three times at once → one sale | tested (interleaved) |
| The same order twice with the pre-check disabled → the receipt inside T1 replays | tested |
| Two orders for the last profile → exactly one gets it | tested (interleaved) |
| Crash after commit / before commit / lost report → one sale | tested with a real Quick Prepare job |
| Two claims truly overlapping skip each other's locked row | PostgreSQL `FOR UPDATE SKIP LOCKED` semantics |
| A repeat inside the first's open transaction waits on the receipt key | PostgreSQL unique-index semantics |

Observed while testing, outside M08: three concurrent **first-ever** purchases for the same brand-new
phone made `customersService.findOrCreateByPhone` return `NOT_FOUND` once in the harness (an
`INSERT … RETURNING` that returned no row and no error, which PostgreSQL does not do). The harness's
multiplexer has shown protocol interleaving before (`bind message supplies N parameters` in suite
logs). Not reproduced on real PostgreSQL; recorded, not fixed.

## 13. Retention

Deferred. Jobs and receipts are small rows and are kept: they are the history the jobs page and the
audit trail point at, and a receipt is what makes a late repeat safe. A future cleanup should delete
only terminal jobs older than a set age, never receipts younger than the longest a client could
retry, and run under the same `SKIP LOCKED` discipline.

---

## Implemented in M08 / required for M09 / deferred

**Implemented in M08**

- Durable queue: schema, lifecycle, constraints, indexes, RLS lockdown, audit.
- Worker contract: enqueue (idempotent), claim (`SKIP LOCKED`, claim token), heartbeat, complete,
  fail / retry with classification and bounded backoff, stale recovery with receipt check, reference
  loop body.
- Idempotency primitive, wired into Quick Prepare and Quick Replace (pre-check, in-transaction
  receipt, safe replay); operation ids from the pages, required by the Server Actions.
- Super Admin jobs page: filters (type, status, UTC dates, search), pagination, states, cancel.

**Required for M09**

- The first job types (`defineJob`) — each that changes business data MUST declare `receipt()` and
  claim it inside its own transaction.
- A long-running worker process (server-side, holding `DATABASE_URL`): a loop of
  `recoverStale(registry)` every few minutes and `processNext(workerId, registry)`; a graceful
  shutdown that stops claiming and lets in-flight jobs finish or go stale.
- Hosting for that worker, its secrets and its monitoring — none exists yet.

**Deferred**

- Job retention / cleanup (§13).
- Cancelling a running job (needs real cooperative cancellation in a handler).
- A manual "retry this failed job" control.
- Real-PostgreSQL concurrency tests (the harness serialises transactions).
