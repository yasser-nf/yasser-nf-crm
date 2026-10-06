# Quick Renew

Extends a subscription a customer already holds. Decisions in
[ADR-015](../.ai/adr/ADR-015-Quick-Renew-Decisions.md).

It allocates no stock, creates no customer and moves nobody between accounts —
Quick Prepare and Quick Replace own those. Where a rule is shared, this module
calls their function rather than restating it.

---

## 1. The flow

```
/quick-renew
   │
   ├─ 1. preview   accountEmail  → account, five slots, who holds them, problems
   ├─ 2. quote     profile + duration → base date, new expiry, days added
   └─ 3. confirm   + expectedExpirationDate → the renewal
```

Steps 1 and 2 **write nothing and take no locks**. An operator can look an
account up, quote three durations and walk away at no cost. Only step 3 opens a
transaction.

---

## 2. Files

| Path | Role |
| --- | --- |
| `services/renewal-duration.ts` | **Pure.** Presets, the renewal base rule, and every date it produces. No `server-only`, no module barrel — so the client imports the same code the server writes with. |
| `services/renewal-eligibility.ts` | Which profiles may be renewed, and why not. Composes existing rules only. |
| `services/renewal-guards.ts` | The permission check and every refusal, with its wording. Shared by both halves so a message cannot drift between the quote and the commit. |
| `services/renewal-lookup.service.ts` | `preview` and `quote`. Reads only. |
| `services/quick-renew.service.ts` | `confirm`: the transaction, history, audit, idempotent replay — and the one service object the module exports. |
| `repositories/renewal.repository.ts` | The reads, including the locking one. **Not exported** from the barrel. |
| `validation/quick-renew.schema.ts` | Input contracts. Duration bounds imported from Quick Prepare. |
| `actions/quick-renew.actions.ts` | Network boundary. Session, context, one service call. |
| `hooks/use-quick-renew.ts` | Three mutations and the operation id. |
| `components/quick-renew-screen.tsx` | Orchestration: which step is showing, what is chosen, what is in flight. |
| `components/renewal-panels.tsx` | The account, problem, subscription and review panels. Presentation only. |
| `components/renewal-duration-picker.tsx` | Five presets plus custom days. |
| `components/renewal-result.tsx` | The success panel. |

**No migration.** `profiles`, `profile_events`, `audit_logs` and
`idempotency_keys` already carry everything a renewal needs.

---

## 3. The expiry rule

```
remainingDays(expiration_date, today) >= 0   →   base = expiration_date   (extend)
otherwise                                    →   base = today             (new term)
```

| | extend | new term |
| --- | --- | --- |
| `sale_date` | unchanged | today |
| `expiration_date` | base + duration | today + duration |
| `duration_days` | `daysBetween(sale_date, new expiry)` | the renewal length |

The second column is `03_DATABASE.md`'s "Expired Profile → Automatically
Available if account is Healthy" applied: a lapsed allocation is stock again, and
selling it is a sale. ADR-015 Decision 2.

`duration_days` is the **whole span**, not the renewal length, because
`profile-dates.ts` makes `expiration = sale_date + duration_days` the source of
truth and the profile editor re-derives from it. ADR-015 Decision 3.

### Presets versus custom days

Presets are **calendar months**, clamped to the target month's last day:

| From | 1 month | 3 months | 1 year |
| --- | --- | --- | --- |
| 2026-10-20 | 2026-11-20 | 2027-01-20 | 2027-10-20 |
| 2026-01-31 | 2026-02-28 | 2026-04-30 | 2027-01-31 |
| 2028-02-29 | 2028-03-29 | 2028-05-29 | 2029-02-28 |

Custom durations are exact days: `2026-10-20 + 30 days = 2026-11-19`.

Bounds are Quick Prepare's, imported rather than restated: 1 to 730 days.

---

## 4. What is refused

| Reason | The rule being applied |
| --- | --- |
| `account_unavailable` | `accountCanAllocate` — not healthy, soft-deleted, a blocking problem open, or the account's own validity gone |
| `slot_not_for_sale` | `isSellableSlot` — above `accounts.profile_slots` |
| `no_customer` | nobody holds the slot, so there is nothing to renew |
| `customer_blocked` | `deriveCustomerStatus` — a blocked customer is still blocked |
| `customer_archived` | the same, with archived outranking blocked |
| beyond account validity | `allocationFitsAccount` — a subscription may not outlive its account |

An **expired** allocation is renewable. Quick Replace refuses one because a
replacement has nothing to carry over; a renewal creates time.

Every refusal is derived twice: once in `preview`/`quote`, so the screen can
explain it before anything is attempted, and again inside the transaction
against the **locked** row, because an account can develop a problem between the
quote and the commit.

---

## 5. Atomicity, concurrency, idempotency

One transaction (`quickRenew.confirm`) holds, in this order:

1. the idempotency receipt (`idempotency.begin` — the first write)
2. `SELECT … FOR UPDATE` on the profile, joined to its account
3. the three preconditions, against the locked row
4. eligibility and the quote, re-derived
5. the `profiles` update
6. the `profile_events` row
7. the customer's purchase timestamps
8. the receipt's result

The audit entry is written after COMMIT through `recordOrWarn`, as every other
mutation does: a renewal that succeeded must not be reported as failed because
its audit row could not be written, and the failure is logged loudly.

### The three preconditions

```
profile.accountId        === accountId               the account it was shown on
profile.customerId       === customerId              the customer it was shown for
profile.expirationDate   === expectedExpirationDate  the expiry that was quoted
```

The third is the concurrency guard. Two operators who both opened the profile
send the same expected expiry; the first commit moves it, so the second is
refused with a `CONFLICT` rather than adding to the first renewal. ADR-015
Decision 5.

### Which guard covers which repeat

| Repeat | Guard |
| --- | --- |
| double click, browser retry, refresh-and-resubmit (same operator) | M08 receipt, scope `quick_renew.confirm` — the first result is replayed |
| two operators, same profile | the expiry precondition under `FOR UPDATE` |
| the adapter retrying its own transaction after a lost COMMIT | the receipt, which is the transaction's first write |
| an operation id reused for a different duration, or by another actor | refused, not replayed — the key is bound to the actor and a request hash |

A replay re-reads the live row and refuses if it has moved on since, rather than
reporting dates that are no longer true.

---

## 6. History and audit

**`profile_events`** — `event_type = 'extended'`, which is the existing value for
"this subscription's dates moved out". `customer-detail.tsx` already labels it
*Renewed* and the Reports module already counts it as an extension, so renewals
appear in both with no change to either. Metadata:

```jsonc
{
  "source": "quick_renew",
  "basis": "current_expiry",        // or "today"
  "renewalLabel": "3 months",
  "renewalPreset": "3_months",      // null for a custom duration
  "renewalDays": 92,
  "customDays": null,
  "profileNumber": 2,
  "from": { "saleDate": "…", "expirationDate": "…", "durationDays": 30 },
  "to":   { "saleDate": "…", "expirationDate": "…", "durationDays": 122 }
}
```

The row itself carries the profile, the account, the customer and the actor, so
the history answers *which profile, who renewed it, when, from what, to what*.

**`audit_logs`** — entity `profile`, action `update`, `event: "profile_renewed"`.
The previous expiry is `before.expirationDate` and the new one is
`after.expirationDate`, both already on the profile allow-list; `renewalDays`
and `renewalPreset` were added to `EVENT_FIELDS` for the renewal length. The PIN
is not on the allow-list and never reaches an audit row.

---

## 7. Security

- `RENEW_SUBSCRIPTIONS`, held by Super Admin and Worker, checked in the
  **service** on all three entry points — including the read-only lookup, so the
  endpoint cannot be used to enumerate accounts. The page's check and the hidden
  sidebar item are courtesies.
- The browser payload is `ProfileView` and `AccountView`: **no PIN, no
  password, no ciphertext**. A renewal has no use for a credential, so none is
  decrypted anywhere in this module.
- Every input is validated server-side; the client's copies exist to save a
  round trip.
- Only `AppError.userMessage` reaches the browser. An unexpected throw becomes
  "Something went wrong. Please try again."
- No raw connection, no service-role key, no client-side database access.

---

## 8. Tests

| File | Covers |
| --- | --- |
| `tests/unit/renewal-duration.test.ts` | `addMonths`, `daysBetween`, the base rule, every preset, 30/90/365 days, month ends, leap years, same-day edges, invalid durations |
| `tests/unit/renewal-eligibility.test.ts` | every refusal, their precedence, and that an expired allocation is renewable |
| `tests/unit/quick-renew-validation.test.ts` | the §8 rejection list, email normalisation, the required preconditions |
| `tests/unit/quick-renew-authorization.test.ts` | the service refuses before any query or transaction |
| `tests/unit/quick-renew-screen.test.tsx` | the whole flow, a blocked profile, a double click, error next to success |
| `tests/integration/quick-renew-m09.test.ts` | the preview writes nothing, atomicity, history, audit, idempotency, two operators, account validity, regression on neighbouring slots |

---

## 9. Known limitations

- **One profile per renewal.** A customer holding three profiles on one account
  is renewed three times. Each is its own transaction, its own event and its own
  audit entry, which is correct but is three confirmations.
- **No price, invoice or payment record.** Nothing in the data model carries
  money, and `orders` is still deferred (ADR-007 Decision 2). A renewal records
  time, not revenue.
- **No renewal through a background job.** `QUICK_RENEW_SCOPE` is exported so a
  job type could run one at most once, but no job type does.
- **No bulk renewal**, and no reminder that a subscription is about to expire
  beyond the existing expiring-soon badges and notifications.
- **The screen collects no note.** `confirmRenewalSchema` accepts one and the
  service writes it onto the `profile_events` row, so a server caller or a later
  job can record why a renewal happened; the operator's screen does not ask for
  it yet.
- **One renewal per confirmation only.** There is no way to renew from the
  account detail page or the customer page; `/quick-renew` is the single entry
  point.
