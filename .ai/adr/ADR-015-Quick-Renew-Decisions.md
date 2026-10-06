# ADR-015 — Quick Renew

**Status:** Accepted
**Date:** 2026-10-06
**Milestone:** Quick Renewing (the "M09 Quick Renewing" brief)
**Supersedes:** nothing
**Amends:** nothing

> **A note on the number.** `CHANGELOG.md` already uses "M09" for the Dashboard
> milestone (0.6.0), while the code comments call Quick Replace "M13". The
> numbering in this repository is not a single sequence, so this record is filed
> under its NAME — Quick Renew — and the brief it implements is identified by
> its title rather than by a number that means two things.

---

## Context

An operator has a customer on the phone who wants more time. Before this
milestone the only ways to give it to them were:

- **Quick Prepare**, which sells a *new* allocation on *different* stock. The
  customer gets a new email and password for no reason, and the profile they
  were already using stays sold to them until it lapses.
- **The profile editor**, which can write a new expiration date by hand. It
  works, it is permission-checked and it writes history — but the operator must
  compute the date themselves, and the dialog offers no durations, no customer
  context and no preview.

Neither is a renewal. The brief asks for one flow that finds the customer by the
account email they hold, shows what they have, and extends it.

The Phase-equivalent discovery found that the data model already supported all of
it: `profiles` carries the dates, `profile_events` carries the history,
`audit_logs` carries the audit trail, and `idempotency_keys` (M08) carries
at-most-once. **No migration was required, and none was written.**

---

## Decision 1 — A live subscription extends from its current expiry

This is the rule the milestone exists for and the only genuinely new business
rule in it.

> Current expiry 20 October. Renew 3 months. New expiry 20 January — whether the
> operator renews on the 1st or on the 19th.

**Decision.** `renewalBasis` returns `current_expiry` whenever
`remainingDays(expiration_date, today) >= 0`, and the renewal counts from that
date. Expiring *today* counts as live: the customer paid for that day.

**Why it is not negotiable.** Counting from today would silently shorten every
early renewal. A customer who renews a week before expiry would lose that week,
and the loss would be invisible — the arithmetic looks right in isolation and
only the customer knows it is wrong.

**Measured by the clock, never by `profiles.status`.** Nothing in this codebase
writes `expired` (ADR-013 Decision 2), so a status check would report every
lapsed allocation as live. The date decides, as it does in `profileCellState`,
`isAllocationExpired` and the allocation engine.

---

## Decision 2 — A lapsed subscription starts today, and that reuses an existing rule

The brief says to reuse the project's existing rule for expired profiles, and to
STOP rather than invent one. There is an existing rule, stated twice:

- `03_DATABASE.md`, Business Rules: *"Expired Profile → Automatically Available
  if account is Healthy."* ADR-013 Decision 2 implemented it by deriving it from
  the date.
- Quick Replace refuses a lapsed allocation outright, with "This customer's
  subscription has already expired, so there is nothing to replace. Prepare a
  new subscription instead."

**Decision.** A lapsed allocation is free stock, and selling it again — to the
same customer, on the same slot — is a sale. A sale starts the day it is made,
exactly as Quick Prepare's does, so the renewal base is **today**,
`sale_date` becomes today, and `duration_days` becomes the renewal length.

**Rejected: extending from the lapsed date.** It would hand the customer a
subscription that was already partly spent — a 30-day renewal of a subscription
that expired 20 days ago would buy them 10 days.

**Rejected: refusing to renew a lapsed subscription.** Quick Replace refuses
one because a *replacement* preserves remaining time and there is none left to
preserve. A renewal creates time, so that reasoning does not transfer, and
refusing would be the invented restriction the brief forbids.

---

## Decision 3 — `duration_days` becomes the whole span, not the renewal length

`profile-dates.ts` makes `expiration = sale_date + duration_days` the source of
truth for a profile's dates, and the profile editor **re-derives** the
expiration from those two fields on every save.

**Decision.** After an extension the row keeps its original `sale_date` and
carries `duration_days = daysBetween(sale_date, new expiration)`. A subscription
sold 20 September for 30 days and renewed by one month ends up as
`sale_date = 2026-09-20`, `expiration_date = 2026-11-20`,
`duration_days = 61`.

**Why.** Writing the renewal length instead would leave a row that disagrees
with itself, and the next unrelated profile edit would silently move the expiry
back to `sale_date + 30`. The renewal length is not lost: it is in the
`profile_events` metadata as `renewalDays` and in the audit entry.

**Consequence.** The original sale date survives every renewal, which is what
makes "when did this customer first buy this profile" answerable.

---

## Decision 4 — Months are calendar months; custom durations are exact days

The brief offers 1, 2, 3, 6 and 12 months *and* custom days, and its own worked
example is `20/10/2026 + 3 months = 20/01/2027` — which is 92 days, not 90.

**Decision.** Presets are calendar months (`addMonths`, new in `lib/dates`);
custom durations are exact days (`addDays`, already there). A preset therefore
lands on the same day of the month, and the day is **clamped** to the target
month's length: 31 January plus one month is 28 (or 29) February, never 2 March.

**Why clamping.** JavaScript's `setUTCMonth` rolls a short month forward, which
turns a one-month renewal into one month and two days, and makes the result
depend on whether the year is a leap year.

**Known discrepancy, recorded rather than resolved silently.** The brief's §9
example says *"Current expiry 20 October, renew 30 days, new expiry 20
November"*. Those are 31 days apart. The §16 example (3 months → 20 January) is
only consistent with calendar months. So the two readings are offered as two
controls: an operator who wants 20 November picks **1 month**; an operator who
wants exactly 30 days picks **custom 30** and gets 19 November. No single
arithmetic can satisfy both examples, and quietly rounding one into the other
would be worse than offering both honestly.

---

## Decision 5 — The concurrency guard is the expiry the operator was shown

Two operators open Profile 2, both see "expires 20 October", both click Confirm.
Idempotency cannot help: they are different people sending different requests
with different operation ids, and both are legitimate.

**Decision.** `confirmRenewalSchema` **requires** `expectedExpirationDate` —
the expiry the quote showed — and the transaction compares it against the row it
locked `FOR UPDATE`. The first commit moves the expiry, so the second no longer
matches and is refused with "this subscription changed while you were reviewing
it".

**Why this rather than a version column.** The expiry *is* the version for this
operation: it is the only field a renewal reads and the only one it writes, it
is already shown to the operator, and a mismatch has an explanation a human can
act on. A generic `updated_at` check would refuse a renewal because somebody
edited the profile's name.

`null` is a legitimate value, not an omission — a live allocation with no
recorded expiry exists in data that predates Quick Prepare — so the field is
required and nullable, and a *missing* field is refused.

**Idempotency is still there, for the other case.** The same operator
confirming twice (a double click, a browser retry, a refresh) sends the same
operation id, and the M08 receipt is the transaction's first write.

---

## Decision 6 — `extended`, not a new event type

**Decision.** A renewal writes a `profile_events` row with
`event_type = 'extended'`, carrying `source: "quick_renew"` in its metadata.

**Why not a new `renewed` value.** It would have needed a migration to add an
enum value, and — worse — every existing consumer would have had to be taught
about it: the Reports module's extensions aggregate counts
`event_type = 'extended'`, and `customer-detail.tsx` already labels that event
**"Renewed"**. A new value would have made every historical report undercount
renewals from the day it shipped.

---

## Decision 7 — A new permission, granted to Workers

**Decision.** `RENEW_SUBSCRIPTIONS`, held by Super Admin and Worker.

**Why not reuse `PREPARE_SUBSCRIPTIONS`.** A renewal is a different capability:
it adds time to an existing subscription rather than consuming stock. Naming it
separately is what lets it be withdrawn from a role without also withdrawing the
ability to sell — which is exactly why `UNASSIGN_SALES` is separate from
`REPLACE_ACCOUNTS`.

**Why Workers hold it.** `01_MASTER_RULES.md`'s "Workers cannot" list is about
deleting accounts, backups, settings, users and sensitive system information.
Renewing a customer's subscription is the same day-to-day operational work a
Worker already does through Quick Prepare and Quick Replace.

**Checked in the service, on every entry point — including the read-only
lookup.** A Server Action is a POST endpoint anybody holding a session can call,
and the lookup answers "does an account with this email exist, and who is on
it". Hiding the sidebar item and the page is a courtesy, not the control.

---

## Decision 8 — Existing refusals are applied, and no new ones are invented

Every reason a renewal is refused is an existing rule expressed through its
existing function:

| Refusal | Rule it applies |
| --- | --- |
| `account_unavailable` | `accountCanAllocate` — 01_MASTER_RULES: a non-Healthy account makes ALL its profiles unavailable |
| `slot_not_for_sale` | `isSellableSlot` — ADR-013 Decision 2 |
| `no_customer` | the brief's §7: reuse the existing relationship, never create a customer |
| `customer_blocked` / `customer_archived` | `deriveCustomerStatus` — *"a blocked customer holding a live profile is still blocked"* |
| beyond the account's validity | `allocationFitsAccount` — ADR-013 / M13 §1: an allocation may not outlive the account carrying it |

**The blocked-customer refusal is the one judgement call**, and it is recorded
here rather than left implicit. Quick Prepare does *not* refuse a blocked
customer today. Renewal does, because `customer-status.ts` states the intent in
so many words: showing a blocked customer as active *"would invite a worker to
serve someone who was deliberately stopped"*, and a renewal is precisely serving
them. Unblocking is a deliberate Super Admin act, and the refusal names it.

**No refusal for a lapsed allocation.** See Decision 2.

---

## Decision 9 — `roleHasPermission` fails closed

Not a Quick Renew decision as such, but found by its tests and fixed with it.

`roleHasPermission` indexed its matrix without a guard, so a role value the
matrix did not know threw `Cannot read properties of undefined` instead of
denying. A throw inside an authorization check is the worst available answer: it
is not a denial any caller can report, and whatever `try/catch` happens to be
above it decides what the user sees.

**Decision.** `ROLE_PERMISSIONS[role]?.includes(permission) ?? false`. An
unknown role holds nothing. The role is typed as a closed union, so this is
unreachable from typed code — but the value comes out of a database column, and
"I do not recognise this role" has exactly one safe reading.
