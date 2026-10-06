import "server-only";

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { databaseAdapter } from "@/lib/database";
import { customers, profileEvents, profiles } from "@/lib/drizzle/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { resolveProfileCustomer, type ProfileCustomerLink } from "@/modules/accounts";
import { auditService, type AuditContext } from "@/modules/audit";
import { idempotency, isReplay, type Receipt } from "@/modules/idempotency";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { renewalRepository } from "../repositories/renewal.repository";
import { confirmRenewalSchema } from "../validation/quick-renew.schema";
import { renewalBlockedReason } from "./renewal-eligibility";
import { quoteRenewal, type RenewalBasis } from "./renewal-duration";
import {
  accountValidityRefusal,
  blockedRenewalMessage,
  movedOn,
  requireRenewer,
  staleReplay,
  toValidationError,
} from "./renewal-guards";
import { renewalLookupService } from "./renewal-lookup.service";

/**
 * Quick Renew service — the commit half. M09.
 *
 * Adds time to a subscription a customer already holds. It allocates nothing,
 * creates no customer, and moves nobody between accounts — which is exactly why
 * it is a separate flow rather than a mode of Quick Prepare or Quick Replace.
 *
 * THREE STEPS, AND WHY THEY ARE SEPARATE
 *
 *   preview   find the account by email, show its profiles and who holds them
 *   quote     what one renewal would do to one profile's dates
 *   confirm   do it
 *
 * The first two live in `renewal-lookup.service.ts` and write nothing at all.
 * Only `confirm` opens a transaction. This is ADR-007 Decision 4's split
 * applied to renewal: the quote is advisory, the commit is the truth.
 *
 * NOTHING IS DECIDED TWICE
 *
 * The date arithmetic lives in `renewal-duration.ts`, the eligibility rules in
 * `renewal-eligibility.ts` and the refusals in `renewal-guards.ts`, all shared
 * by both halves. So the expiry an operator is shown is the expiry the column
 * receives, and the refusal they meet at confirmation is the message the screen
 * already showed them.
 *
 * AUTHORIZATION IS HERE, NOT IN THE ACTION
 *
 * Every entry point checks `RENEW_SUBSCRIPTIONS` itself, including the
 * read-only ones. A Server Action is a POST endpoint anybody holding a session
 * can call, and the lookup answers "does an account with this email exist and
 * who is on it" — a question a role without renewal rights has no business
 * asking. M09 §22: UI hiding is not authorization.
 */

/** Receipt scope (M08 jobs). One renewal per quoted renewal. */
export const QUICK_RENEW_SCOPE = "quick_renew.confirm";

/** M09 §17: what happened. */
export interface RenewalResult {
  readonly profileId: string;
  readonly profileNumber: number;
  readonly profileName: string | null;
  readonly accountId: string;
  readonly accountEmail: string;
  readonly customer: ProfileCustomerLink;
  readonly previousExpirationDate: string | null;
  readonly expirationDate: string;
  readonly saleDate: string;
  readonly durationDays: number;
  readonly addedDays: number;
  readonly basis: RenewalBasis;
  readonly renewalLabel: string;
  /**
   * M08 jobs: true when this response repeats a renewal that had already
   * committed — the same confirmation arriving twice — rather than performing
   * one. The dates are re-read from the live row, never from storage.
   */
  readonly replayed: boolean;
}

/**
 * What a committed renewal records in its receipt: references and dates only.
 *
 * No PIN, no credential, no phone number. Enough to find the row again and
 * check it still says what the receipt says.
 */
const renewalReceiptSchema = z.object({
  profileId: z.uuid(),
  accountId: z.uuid(),
  customerId: z.uuid(),
  previousExpirationDate: z.string().nullable(),
  expirationDate: z.string(),
  saleDate: z.string(),
  durationDays: z.number().int(),
  addedDays: z.number().int(),
  basis: z.enum(["current_expiry", "today"]),
  renewalLabel: z.string(),
});

/* ------------------------------------------------------------------ confirm */

/**
 * Step three: renew.
 *
 * ATOMICITY (M09 §12). The profile's new dates, the history event and the
 * idempotency receipt are written in one transaction. Either the subscription
 * is renewed and the history says so, or nothing happened — there is no state
 * in which a profile carries a new expiry that no event explains.
 *
 * The audit entry is written after COMMIT, through `recordOrWarn`, exactly as
 * every other mutation in this codebase does: a renewal that succeeded must not
 * be reported as failed because its audit row could not be written, and a
 * failed audit write is logged loudly instead.
 *
 * CONCURRENCY (M09 §13). The profile row is locked FOR UPDATE and three
 * preconditions are re-checked against what the lock returns, not against what
 * the browser sent:
 *
 *   - it still belongs to the account the operator was shown
 *   - it is still held by the customer they were shown
 *   - its expiry is still the one they were quoted
 *
 * The third is what defeats two operators renewing the same profile. They send
 * different operation ids — different people, different requests — so
 * idempotency cannot help; the first commit moves the expiry, and the second
 * finds a row that no longer matches its quote and is refused.
 *
 * IDEMPOTENCY (M09 §11). The same operator confirming twice — a double click, a
 * browser retry, a refresh-and-resubmit — sends the SAME operation id, and the
 * receipt is the transaction's first write. Whatever the timing, the renewal
 * commits once and the repeat replays its result.
 */
async function confirm(input: unknown, context: AuditContext): Promise<Result<RenewalResult>> {
  const permitted = requireRenewer(context);

  if (!permitted.ok) {
    return permitted;
  }

  const actor = permitted.value;

  const parsed = confirmRenewalSchema.safeParse(input);

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues));
  }

  const { profileId, accountId, customerId, expectedExpirationDate, duration, notes } = parsed.data;

  /*
   * Bound to the actor and to a hash of what was asked, so one operator's
   * confirmation id cannot replay another's, and reusing an id for a different
   * duration is refused rather than silently replayed as the first.
   */
  const operation = idempotency.operation(
    QUICK_RENEW_SCOPE,
    parsed.data.operationId ?? randomUUID(),
    actor.id,
    { profileId, accountId, customerId, expectedExpirationDate, duration, notes: notes ?? null },
  );

  /* Cheap pre-check: a repeat of a committed renewal replays before touching anything. */
  const prior = await idempotency.lookup(operation);

  if (!prior.ok) {
    return prior;
  }

  if (prior.value) {
    return replayRenewal(prior.value);
  }

  const committed = await databaseAdapter.transaction("quickRenew.confirm", async (executor) => {
    /*
     * The receipt, FIRST. A repeat that got past the pre-check — two clicks
     * arriving together, or this transaction being retried after a COMMIT
     * whose acknowledgement was lost — stops here and replays, because
     * `IdempotentReplay` rolls this attempt back.
     */
    await idempotency.begin(executor, operation);

    const locked = await renewalRepository.lockProfile(executor, profileId);

    if (!locked) {
      throw new NotFoundError("Profile not found for renewal", {
        userMessage: "That profile no longer exists. Look the account up again.",
      });
    }

    const { profile, account, hasBlockingProblem } = locked;

    if (profile.accountId !== accountId) {
      throw movedOn("the profile no longer belongs to that account");
    }

    if (profile.customerId !== customerId) {
      throw movedOn("the profile is held by a different customer now");
    }

    /*
     * The quote's premise, re-verified under lock. `?? null` on both sides so a
     * profile that genuinely carries no expiry compares equal to the `null` the
     * operator was shown, rather than to `undefined`.
     */
    if ((profile.expirationDate ?? null) !== expectedExpirationDate) {
      throw movedOn("the expiry has changed since it was quoted");
    }

    const customerRows = await executor
      .select()
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);

    const customer = customerRows[0] ?? null;

    const now = new Date();

    /*
     * Eligibility re-derived from the LOCKED row and the account carrying it,
     * never from the preview. An account can develop a problem, be archived or
     * run out of validity between the quote and the commit, and the only
     * answer that matters is the one true when the write happens.
     */
    const blocked = renewalBlockedReason(
      { account, profile, hasActiveProblem: hasBlockingProblem, customer },
      now,
    );

    if (blocked) {
      throw new ValidationError(`Profile is not renewable: ${blocked}`, {
        userMessage: blockedRenewalMessage(blocked),
      });
    }

    const computed = quoteRenewal(profile, duration, now);

    if (!computed) {
      throw new ValidationError("Renewal duration produced no usable expiry", {
        userMessage: "That renewal length could not be applied. Choose a different duration.",
        fieldErrors: { days: "Enter a valid number of days" },
      });
    }

    const refusal = accountValidityRefusal(account, computed, now);

    if (refusal) {
      throw refusal;
    }

    const updated = await executor
      .update(profiles)
      .set({
        /*
         * `sold` is asserted rather than assumed. Nothing in this codebase ever
         * writes `expired` (ADR-013 D2), so a lapsed allocation is still
         * labelled `sold` and this is usually a no-op — but a row reached by
         * some other path must not be left saying `available` while holding a
         * customer, which `profiles_held_requires_customer` would refuse
         * anyway. The customer is non-null here: `renewalBlockedReason`
         * returned null, which requires one.
         */
        status: "sold",
        saleDate: computed.saleDate,
        expirationDate: computed.expirationDate,
        durationDays: computed.durationDays,
        /* The renewal is this operator's work, as a sale is the seller's. */
        workerId: actor.id,
        updatedAt: sql`now()`,
      })
      .where(eq(profiles.id, profileId))
      .returning();

    const next = updated[0];

    if (!next) {
      throw new ConflictError("Renewal update returned no row");
    }

    /*
     * History. ADR-006 Decision 1 makes `profile_events` the only event source,
     * so a renewal that skipped one would be invisible in both the profile
     * history and the account timeline.
     *
     * `extended` is the existing event type for "this subscription's dates
     * moved out", already labelled "Renewed" on the customer screen and already
     * counted by the Reports module's extensions aggregate. A new enum value
     * would have needed a migration and would have made every existing report
     * undercount renewals.
     *
     * The metadata carries the BEFORE values, which is what makes the history
     * answer M09 §10: what it was, what was added, what it became, who did it
     * and when. The row itself carries the profile, the account, the customer
     * and the actor. No PIN and no password — this table is read by history
     * views.
     */
    await executor.insert(profileEvents).values({
      accountId: account.id,
      profileId: profile.id,
      eventType: "extended",
      userId: actor.id,
      customerId,
      metadata: {
        source: "quick_renew",
        basis: computed.basis,
        renewalLabel: computed.label,
        renewalPreset: computed.preset,
        renewalDays: computed.addedDays,
        customDays: computed.customDays,
        profileNumber: profile.profileNumber,
        from: {
          saleDate: profile.saleDate,
          expirationDate: profile.expirationDate,
          durationDays: profile.durationDays,
        },
        to: {
          saleDate: computed.saleDate,
          expirationDate: computed.expirationDate,
          durationDays: computed.durationDays,
        },
      },
      ...(notes ? { notes } : {}),
    });

    /*
     * The customer bought something. The same two timestamps Quick Prepare
     * maintains — ADR-007 Decision 2 defers the orders table, so these are the
     * only record of when this customer last paid for anything, and a renewal
     * is a purchase.
     */
    await executor
      .update(customers)
      .set({
        lastPurchaseAt: sql`now()`,
        firstPurchaseAt: sql`coalesce(${customers.firstPurchaseAt}, now())`,
        updatedAt: sql`now()`,
      })
      .where(eq(customers.id, customerId));

    await idempotency.complete(executor, operation, {
      profileId: profile.id,
      accountId: account.id,
      customerId,
      previousExpirationDate: profile.expirationDate,
      expirationDate: computed.expirationDate,
      saleDate: computed.saleDate,
      durationDays: computed.durationDays,
      addedDays: computed.addedDays,
      basis: computed.basis,
      renewalLabel: computed.label,
    });

    return { previous: profile, next, account, customer, computed };
  });

  if (!committed.ok) {
    return isReplay(committed.error) ? replayRenewal(committed.error.receipt) : committed;
  }

  const { previous, next, account, customer, computed } = committed.value;

  /*
   * M09 §19. Entity `profile`, so the before/after snapshots are filtered by
   * the profile allow-list — which already covers sale date, expiration and
   * duration, and already EXCLUDES the PIN (the M01 finding). The previous
   * expiry is `before.expirationDate` and the new one is `after.expirationDate`,
   * so the audit trail answers §19 out of columns that were already audited
   * rather than out of new free-form fields.
   */
  await auditService.recordOrWarn(
    {
      entity: "profile",
      entityId: next.id,
      action: "update",
      before: profileAuditSnapshot(previous),
      after: {
        ...profileAuditSnapshot(next),
        event: "profile_renewed",
        renewalDays: computed.addedDays,
        renewalPreset: computed.preset ?? "custom",
        changedFields: ["saleDate", "expirationDate", "durationDays"].filter(
          (field) =>
            previous[field as "saleDate" | "expirationDate" | "durationDays"] !==
            next[field as "saleDate" | "expirationDate" | "durationDays"],
        ),
      },
    },
    context,
  );

  return ok({
    profileId: next.id,
    profileNumber: next.profileNumber,
    profileName: next.profileName,
    accountId: account.id,
    accountEmail: account.email,
    customer: resolveProfileCustomer(next.customerId, customer),
    previousExpirationDate: previous.expirationDate,
    expirationDate: computed.expirationDate,
    saleDate: computed.saleDate,
    durationDays: computed.durationDays,
    addedDays: computed.addedDays,
    basis: computed.basis,
    renewalLabel: computed.label,
    replayed: false,
  });
}

/**
 * The columns a renewal's audit entry records — and, by omission, the PIN it
 * never does.
 *
 * Deliberately a copy of the shape `profiles.service.ts` audits rather than an
 * import: that function is private to the accounts module, and ADR-003 forbids
 * reaching past a module's public API. The audit service's allow-list is the
 * enforcement either way (`pin` is not on it, and is dropped centrally), so
 * this is the statement of intent beside the data, not the guard.
 */
function profileAuditSnapshot(row: {
  readonly id: string;
  readonly accountId: string;
  readonly profileNumber: number;
  readonly profileName: string | null;
  readonly status: string;
  readonly customerId: string | null;
  readonly workerId: string | null;
  readonly saleDate: string | null;
  readonly expirationDate: string | null;
  readonly durationDays: number | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    accountId: row.accountId,
    profileNumber: row.profileNumber,
    profileName: row.profileName,
    status: row.status,
    customerId: row.customerId,
    workerId: row.workerId,
    saleDate: row.saleDate,
    expirationDate: row.expirationDate,
    durationDays: row.durationDays,
  };
}

/**
 * Repeats a committed renewal's RESULT without repeating the renewal.
 *
 * Nothing is written and nothing is audited. The row the receipt names is read
 * back and must still say exactly what the receipt says — same customer, same
 * new expiry. If it moved on since (a later renewal, a replacement, an
 * unassignment), the replay refuses rather than report dates that are no longer
 * true.
 */
async function replayRenewal(receipt: Receipt): Promise<Result<RenewalResult>> {
  const parsed = renewalReceiptSchema.safeParse(receipt.result);

  if (!parsed.success) {
    return fail(staleReplay());
  }

  const recorded = parsed.data;
  const read = await renewalRepository.readProfile(recorded.profileId);

  if (!read.ok) {
    return read;
  }

  const found = read.value;

  const intact =
    found !== null &&
    found.account.id === recorded.accountId &&
    found.profile.customerId === recorded.customerId &&
    found.profile.expirationDate === recorded.expirationDate;

  if (!found || !intact) {
    return fail(staleReplay());
  }

  return ok({
    profileId: found.profile.id,
    profileNumber: found.profile.profileNumber,
    profileName: found.profile.profileName,
    accountId: found.account.id,
    accountEmail: found.account.email,
    customer: resolveProfileCustomer(found.profile.customerId, found.customer),
    previousExpirationDate: recorded.previousExpirationDate,
    expirationDate: recorded.expirationDate,
    saleDate: recorded.saleDate,
    durationDays: recorded.durationDays,
    addedDays: recorded.addedDays,
    basis: recorded.basis,
    renewalLabel: recorded.renewalLabel,
    replayed: true,
  });
}

/**
 * The module's one service object: the read-only steps and the commit.
 *
 * Composed here rather than exposing two objects, so a caller cannot reach the
 * commit without having gone past the same authorization the lookup applies.
 */
export const quickRenewService = {
  preview: renewalLookupService.preview,
  quote: renewalLookupService.quote,
  confirm,
} as const;
