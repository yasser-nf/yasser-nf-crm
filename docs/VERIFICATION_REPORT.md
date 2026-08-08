# Runtime Verification Report

Milestone: M04.5
Date: 2026-08-08
Target: live Supabase project, PostgreSQL 17.6, session pooler

**55 checks · 54 passed · 1 failed (a known gap, deliberately recorded as failing)**
**0 residual test rows.**

---

## 1. Method

Verification ran the **real services against the real database** through a
temporary harness route, not through the UI.

That was a deliberate choice, and it is why the sprint found what it did. UI
clicking cannot force a transaction rollback, cannot run three allocations
simultaneously, and cannot assert which error class a constraint violation
produces. Every one of those checks is where the bugs were.

The harness created business data and deleted it afterwards. Residue was
measured on every run and was zero each time.

**Not verified: anything requiring an authenticated browser session.** Login,
logout, dashboard render, sidebar behaviour and session refresh remain
unverified because signing in requires a password, which is outside what I may
handle. See `KNOWN_LIMITATIONS.md`.

---

## 2. Bugs Found And Fixed

### BUG-01 — Database error translation was entirely dead · **HIGH** · FIXED

**Symptom.** An intermittent harness failure: three concurrent
`findOrCreateByPhone` calls produced one customer row, correctly, but only 1 of
3 calls returned success. It passed on the first run and failed on the next two.

**Root cause.** `translateDriverError` inspected the thrown value for a string
`code`. Drizzle does not rethrow the driver's error — it wraps it in a
`DrizzleQueryError` carrying the SQL and parameters, and hangs the original off
`cause`. The top-level object therefore never carried a SQLSTATE.

**Consequence, which was much larger than the symptom.** Since M02, *every*
constraint violation surfaced as `UnexpectedError` rather than `ConflictError`
or `DatabaseError`. The entire SQLSTATE mapping was unreachable code. So was the
retry policy — `isRetryable` used the same guard, so serialization failures,
deadlocks and dropped connections were never retried.

Downstream, `customersService` branches on `instanceof ConflictError` to recover
from a lost race. That branch could never be taken, so a legitimate race
returned a hard failure to the caller.

**Why it survived M02, M03 and M04.** Every previous check asserted only that a
violation *threw*. It did. It threw the wrong class, and nothing looked.

**Fix.** `findDriverError` walks the `cause` chain to a depth of six, and the
result is validated against the SQLSTATE shape `[0-9A-Z]{5}` so Node error codes
like `ECONNRESET` are not mistaken for one. Network codes are handled separately
and are also now retryable.

**Verified.** 23505 → `ConflictError`, 23503 → `ConflictError`, 23514 →
`DatabaseError`. The race passes 3/3 across repeated runs.

### BUG-02 — Handled failures logged as errors · **LOW** · FIXED

A customer race that the service recovered from cleanly still emitted
`level: "error"` from the adapter. In production that is an alert for something
that worked.

Operational failures — the expected conditions `AppError.isOperational` marks —
now log at `warn` with the operation and code. Genuine defects still log as
errors with full context.

### BUG-03 — Index count drift in documentation · **LOW** · FIXED

Documentation claimed 38 indexes; the live schema has 39 declared plus 8
implicit primary-key indexes. M03 added `profile_events_account_created_idx` and
the count was not updated. Corrected during migration verification.

---

## 3. Results By Area

### Authentication — PARTIAL

| Check | Result |
| ----- | ------ |
| Login page reaches live Supabase | ✅ real round trip |
| Wrong credentials rejected | ✅ "Email or password is incorrect." |
| Email enumeration prevented | ✅ identical wording for unknown address |
| No session created on failure | ✅ stayed on `/login` |
| Protected route redirect | ✅ `/accounts` → `/login?next=%2Faccounts` |
| Successful login | ⛔ **UNVERIFIED** — requires a password |
| Logout, session persistence, refresh | ⛔ **UNVERIFIED** |

### Accounts — 8/8

Create (586 ms) · password encrypted at rest · decryption round trip · audit log
written · archive sets `archived_at` · restore clears it · restore refuses a
non-archived account · timeline generated (343 ms).

Soft delete correctly **refused** — `assertMayDelete` fails closed because the
session carries no role. Documented behaviour, verified as such.

### Profiles — 7/7

Exactly five created automatically · numbered 1–5 · five `created` events · every
event carries `account_id` · name and PIN editable · `name_changed` and
`pin_changed` events raised · a no-op edit writes no event.

### Quick Prepare — 8/8

Preview (230 ms) · confirmation allocates and returns credentials (923 ms) ·
clipboard format matches the brief · WhatsApp link `https://wa.me/213…` ·
expiration = today + duration · profiles marked sold with customer and expiry ·
`sold` events written · stock count decreases.

### Business Rules — 8/8

All four Algerian phone formats normalise to `663947116` · customer find-or-create
creates once and reuses thereafter · **an unhealthy account blocks all 5 profiles**
· an unhealthy account is excluded from allocation candidates entirely.

### Transactions — 2/2

An impossible allocation (999 profiles) fails cleanly with `VALIDATION_ERROR`,
and the sold-profile count is **identical before and after**. Nothing partially
written.

### Concurrency — 2/2

Three parallel `findOrCreateByPhone` calls yield exactly one row, all three
succeeding. Two parallel confirmations never hand out the same profile —
`SKIP LOCKED` behaving as designed.

### Database — 12/12

Rejected as expected: `profile_number` > 5, `health_score` > 100, duplicate
`(account_id, profile_number)`, an available profile holding a customer, an
orphan foreign key, a duplicate live email, a non-digit normalised phone.

Soft-deleted accounts are invisible to reads, and the email becomes reusable —
the partial unique index working as intended.

Error classes now assert correctly (BUG-01 regression guards).

### Security — 7/8

Encryption round trip · same plaintext yields different ciphertext · **tampered
ciphertext rejected by the GCM auth tag** · password stored as `v1:…` never
plaintext · password redacted from audit snapshots · actor email denormalised ·
**PIN never written to event metadata**.

**RLS is not enabled on any table.** Recorded as a failing check because
`03_DATABASE.md` requires it.

---

## 4. Performance

| Operation | Time | Note |
| --------- | ---- | ---- |
| Preview allocation | 230 ms | 2 queries regardless of request size |
| Customer find-or-create | 237 ms | |
| Timeline (25 events) | 343 ms | one index range read |
| Create account + 5 profiles + 5 events | 586 ms | single transaction |
| Quick Prepare confirmation | 923 ms | lock, allocate, 3 writes, decrypt |

Measured against a remote pooler from a development machine, so each figure
includes real network latency. Quick Prepare at **0.9 s** is comfortably inside
the 5 s target in `01_MASTER_RULES.md`.

**No N+1 queries observed.** Allocation issues two queries irrespective of size;
writes are batched into one `UPDATE` and one `INSERT` rather than one per
profile; the accounts list aggregates counts with `count(*) FILTER` over a join
rather than loading five profiles per row.

---

## 5. Code Quality

| Check | Result |
| ----- | ------ |
| `npm run verify` (6 gates) | ✅ exit 0 |
| `any` types | 0 |
| TODO / FIXME | 0 |
| Lint suppressions | 0 |
| Circular dependencies | 0 |
| React / hydration warnings | none observed |
| Console errors | none on clean load |
| Residual test data | 0 |

---

## 6. Runtime Observations

The adapter's retry policy is now reachable but **has never actually fired** —
no transient failure occurred during testing. It is correct by inspection, not
by observation.

Repeated harness runs produced identical results once BUG-01 was fixed, which is
the useful signal: the intermittency was a real defect, not test flakiness.
