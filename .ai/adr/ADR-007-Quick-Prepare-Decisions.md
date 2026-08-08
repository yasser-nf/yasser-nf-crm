# ADR-007
# Quick Prepare Decisions

Status: ACCEPTED

Date: 2026-08-08

Owner: Yasser Saidi

Amends: 01_MASTER_RULES.md, 03_DATABASE.md

---

# Decision 1 — "Best Distribution" Means Anti-Fragmentation

## Context

01_MASTER_RULES.md tells the Smart Stock Engine to prioritise Healthy accounts,
Available profiles, "Best Distribution", Highest Health Score and Lowest Problem
History.

03_DATABASE.md lists the same factor as "Distribution".

Neither document defines it, and the word admits two opposite readings: spread
the sale across many accounts, or concentrate it into few.

The M04 brief resolves it explicitly:

Choose the minimum number of accounts.

Prefer accounts already partially sold.

Avoid fragmentation.

## Decision

"Best Distribution" means concentration, not spreading.

The engine minimises the number of accounts touched, and prefers accounts that
already have sold profiles.

## Why this is a definition rather than a contradiction

The business reason is operational, not technical. A customer who buys three
profiles across three different accounts receives three sets of credentials and
must manage three logins. The same three profiles on one account is one email,
one password, one thing to explain over WhatsApp.

Fragmentation also destroys future capacity: five accounts each holding one free
profile cannot serve a customer who wants two, while one account holding five can
serve anyone.

Concentration is therefore the distribution that keeps the most future options
open, which is what "best" must mean for a stock engine.

## Consequence

Selection scores accounts by how nearly they can satisfy the whole request on
their own, and among equals prefers the one already partly sold.

An account is never chosen because it appeared first. 01_MASTER_RULES.md forbids
that, and the ordering below is total, so ties resolve deterministically rather
than by table order.

---

# Decision 2 — A Sale Writes No Order Row

## Decision

Quick Prepare records a sale through profile mutations, profile_events and
audit_logs. It does not create an order.

## Why

ADR-005 Decision 1 deferred the orders table, and the M04 brief lists exactly
what a confirmation must produce:

Assign customer

Assign expiration

Update profile status

Create profile event

Create audit log

No order appears in that list.

## Consequence — stated plainly

Sales history currently lives only in profile_events. That is sufficient to
answer "what happened to this profile" and "what happened on this account".

It is NOT sufficient to answer "what did this customer buy" or "what did we sell
last month" without scanning events. Reporting and customer purchase history
both need the orders table, and both are later milestones.

profiles.first_purchase_at and last_purchase_at on customers are maintained by
this engine so the customer list is not left empty in the meantime.

---

# Decision 3 — Customers Gain A Minimal Service

## Context

Quick Prepare takes a phone number and must attach a customer to the allocated
profiles. M03 excluded Customer Management, and M02 built a customers repository
with no service above it.

## Decision

A customers service is added with one capability: find-or-create by normalized
phone.

Nothing else. No editing, no listing, no customer screens.

## Why

The brief requires a customer to be assigned, and 01_MASTER_RULES.md defines
customer identity as the normalized WhatsApp number. Creating that customer is
not Customer Management — it is the minimum needed for allocation to complete.

## Concurrency

find-or-create races: two workers preparing for the same new customer at the same
moment would both find nothing and both insert.

The database already forbids the duplicate through the partial unique index on
phone_normalized. The service therefore attempts the insert and treats a
ConflictError as "someone else won, read theirs" rather than checking first and
hoping.

---

# Decision 4 — The Preview Is Advisory, The Confirm Is Authoritative

## Context

The flow shows a worker which profiles they are about to receive, then asks them
to confirm. Between those two moments another worker can take the same profiles.

## Rejected — reserving during preview

Setting profiles to `reserved` when the preview renders would need an expiry
sweep to release abandoned previews, and every crashed tab or closed laptop would
strand stock until that sweep ran.

## Decision

Preview performs a read with no locks and no writes.

Confirmation re-runs selection inside a single transaction, locking the candidate
rows with FOR UPDATE SKIP LOCKED, and allocates from what it actually holds.

If the stock moved between preview and confirm, the confirm allocates the new
best answer rather than failing, and the response tells the worker what they
actually received.

## Why

The brief requires everything to happen in one transaction. This satisfies it
without inventing a reservation lifecycle that has no owner.

SKIP LOCKED matters: without it, two concurrent confirmations queue behind each
other on the same rows and the second waits for the first. With it, the second
immediately considers different stock.

---

# Decision 5 — Phone And Clipboard Engines

02_ARCHITECTURE.md already names both and states that no feature may normalise a
phone number itself.

lib/phone

Normalises every Algerian format to the 9-digit national number, generates the
wa.me URL, and reports why an input was rejected.

lib/clipboard

Produces the standardised credential block the brief specifies. The format is
defined once so every screen that copies credentials produces identical text.

Neither contains business logic. Both are pure functions.

---

# Final Decision

These decisions are adopted. Changing any requires a new ADR and approval from
the project owner.

---

END OF ADR-007
