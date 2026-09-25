import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { databaseAdapter } from "@/lib/database";
import { decryptSecret } from "@/lib/crypto";
import { remainingDays } from "@/lib/dates";
import { customers, profileEvents, profiles } from "@/lib/drizzle/schema";
import { ValidationError } from "@/lib/errors";
import { formatPreparation, type AccountCredential } from "@/lib/clipboard";
import { normalizeIdentifier } from "@/lib/phone";
import { auditService, type AuditContext } from "@/modules/audit";
import { customersService } from "@/modules/customers";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { allocationRepository } from "../repositories/allocation.repository";
import {
  buildAllocationPlan,
  computeExpirationDate,
  todayAsDate,
  type AllocationPlan,
} from "./allocation-engine";
import { quickReplaceService } from "./quick-replace.service";
import {
  confirmReplacementSchema,
  previewAllocationSchema,
  quickPrepareSchema,
  type QuickPrepareInput,
} from "../validation/quick-prepare.schema";

/**
 * Quick Prepare service.
 *
 * The flagship flow. 01_MASTER_RULES.md targets under five seconds end to end,
 * which is why the expensive parts — candidate selection and every write — happen
 * in exactly one round trip each rather than per profile.
 *
 * ADR-007 Decision 4: preview reads without locks; confirmation re-selects
 * inside a transaction holding row locks. The preview is a suggestion, the
 * confirmation is the truth.
 */

export interface PreparedProfile {
  readonly profileId: string;
  readonly profileNumber: number;
  readonly profileName: string | null;
  readonly pin: string | null;
}

export interface PreparedAccount {
  readonly accountId: string;
  readonly email: string;
  readonly password: string;
  readonly profiles: readonly PreparedProfile[];
}

export interface PreparationPreview {
  readonly accounts: readonly {
    readonly accountId: string;
    readonly email: string;
    readonly profileNumbers: readonly number[];
    /** Days left on the account's own coverage. Null means open-ended. */
    readonly remainingValidityDays: number | null;
    /**
     * M13 §7. This account previously served a customer whose allocation has
     * lapsed, so the old customer still knows the password.
     */
    readonly requiresPasswordChange: boolean;
  }[];
  readonly requested: number;
  readonly availableTotal: number;
  /** Profiles that exist but whose account cannot cover the requested duration. */
  readonly excludedForValidity: number;
  /** The date the customer's subscription would end, if confirmed now. */
  readonly expirationDate: string;
  readonly durationDays: number;
  /** True when ANY offered account needs its password changed first. */
  readonly requiresPasswordChange: boolean;
}

export interface PreparationResult {
  readonly customerId: string;
  readonly customerPhone: string;
  readonly whatsappUrl: string;
  readonly customerIsNew: boolean;
  readonly expirationDate: string;
  readonly durationDays: number;
  readonly accounts: readonly PreparedAccount[];
  /** The standardised block, ready to paste. */
  readonly clipboardText: string;
  /**
   * True when one of the allocated accounts previously served a customer whose
   * subscription lapsed.
   *
   * Still reported AFTER confirmation, deliberately: the operator ticked a box
   * saying they changed the password, and the result screen is where they
   * verify that before sending the credentials on. A warning that disappears
   * the moment it is acknowledged is a warning nobody re-reads.
   */
  readonly requiresPasswordChange: boolean;
}

/**
 * Turns a short plan into the failure a worker should see.
 *
 * M13 splits this into two genuinely different messages. "There is no stock"
 * and "there is stock, but none of it lasts long enough" need opposite
 * responses — buy more accounts, versus offer this customer a shorter
 * subscription — and reporting both as "not enough profiles" hides the second
 * behind the first.
 *
 * The Phase B approval requires the numbers, not just the reason:
 *
 *   Only 18 days remaining. Customer requested 90 days.
 */
function shortStockError(plan: AllocationPlan): ValidationError {
  /* Stock existed and every bit of it was too short-dated. */
  if (plan.availableTotal < plan.requested && plan.excludedForValidity > 0) {
    /* The closest miss is the most useful one to quote. */
    const best = [...plan.rejected].sort(
      (left, right) => (right.remainingDays ?? 0) - (left.remainingDays ?? 0),
    )[0];

    const requestedDays = best?.requestedDays ?? 0;
    const remaining = best?.remainingDays ?? 0;

    return new ValidationError(
      `Requested ${plan.requested} profiles for ${requestedDays} days; ` +
        `${plan.excludedForValidity} excluded for insufficient account validity`,
      {
        userMessage:
          plan.availableTotal === 0
            ? `No account has enough validity left. The best has only ${remaining} day${
                remaining === 1 ? "" : "s"
              } remaining, and the customer requested ${requestedDays} days.`
            : `Only ${plan.availableTotal} profile${
                plan.availableTotal === 1 ? " has" : "s have"
              } enough remaining validity for ${requestedDays} days.`,
        fieldErrors: {
          durationDays: `Best account has ${remaining} day${remaining === 1 ? "" : "s"} left`,
          profileCount: `Available for this duration: ${plan.availableTotal}`,
        },
      },
    );
  }

  return new ValidationError(
    `Requested ${plan.requested} profiles, only ${plan.availableTotal} allocatable`,
    {
      userMessage:
        plan.availableTotal === 0
          ? "No profiles are available on healthy accounts right now."
          : `Only ${plan.availableTotal} profile${plan.availableTotal === 1 ? " is" : "s are"} available right now.`,
      fieldErrors: { profileCount: `Maximum available: ${plan.availableTotal}` },
    },
  );
}

/**
 * Shows what the engine would allocate, without taking anything.
 *
 * No locks and no writes, so an abandoned preview costs nothing and strands no
 * stock. The credentials are deliberately absent — a preview is a plan, not a
 * delivery, and decrypting passwords for something that may never be confirmed
 * would spread secrets for no reason.
 */
async function preview(input: unknown): Promise<Result<PreparationPreview>> {
  const parsed = previewAllocationSchema.safeParse(input);

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues));
  }

  const { profileCount, durationDays } = parsed.data;

  const candidates = await allocationRepository.findCandidates();

  if (!candidates.ok) {
    return candidates;
  }

  /*
   * The duration is applied here, not only at confirmation. A preview that
   * offers an account the confirm step will refuse is worse than no preview —
   * the worker has already told the customer which account they are getting.
   *
   * `durationDays` is required by the schema rather than optional, because it
   * was previously optional and the Server Action forgot to pass it. Making the
   * omission unrepresentable is the fix; a comment asking callers to remember
   * is not.
   */
  const plan = buildAllocationPlan(candidates.value, profileCount, {
    requestedDurationDays: durationDays,
  });

  if (plan.isShort) {
    return fail(shortStockError(plan));
  }

  /*
   * M13 §7, decided on the server. The UI renders this; it does not compute it.
   * One batched query for every offered account rather than one per account.
   */
  const reuse = await allocationRepository.accountsNeedingPasswordChange(
    plan.slices.map((slice) => slice.account.id),
  );

  if (!reuse.ok) {
    return reuse;
  }

  const now = new Date();

  return ok({
    accounts: plan.slices.map((slice) => ({
      accountId: slice.account.id,
      email: slice.account.email,
      profileNumbers: slice.profiles.map((profile) => profile.profileNumber),
      /* Surfaced so the review step can warn before anything is committed. */
      remainingValidityDays:
        candidates.value.find((candidate) => candidate.account.id === slice.account.id)
          ?.remainingValidityDays ?? null,
      requiresPasswordChange: reuse.value.has(slice.account.id),
    })),
    requested: plan.requested,
    availableTotal: plan.availableTotal,
    excludedForValidity: plan.excludedForValidity,
    /*
     * Shown before anything is committed, so the operator sees the date the
     * customer will actually get. Computed by the same helper `confirm` uses.
     */
    expirationDate: computeExpirationDate(now, durationDays),
    durationDays,
    requiresPasswordChange: plan.slices.some((slice) => reuse.value.has(slice.account.id)),
  });
}

/**
 * Allocates profiles and records the sale.
 *
 * Everything below the customer lookup happens in one transaction: selection
 * under lock, the profile updates, the events, and the customer's purchase
 * timestamps. If any part fails, none of it happened — a customer is never left
 * holding half an order.
 *
 * The customer is resolved before the transaction opens. Creating them inside it
 * would hold profile locks across a second write path for no benefit, and a
 * customer created for an allocation that then fails is harmless.
 */
async function confirm(input: unknown, context: AuditContext): Promise<Result<PreparationResult>> {
  const parsed = quickPrepareSchema.safeParse(input);

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues));
  }

  const request: QuickPrepareInput = parsed.data;

  const phone = normalizeIdentifier(request.phone);

  if (!phone.ok) {
    return phone;
  }

  const customerResult = await customersService.findOrCreateByPhone(
    request.phone,
    undefined,
    context,
  );

  if (!customerResult.ok) {
    return customerResult;
  }

  const { customer, created: customerIsNew } = customerResult.value;

  const now = new Date();
  const saleDate = todayAsDate(now);
  const expirationDate = computeExpirationDate(now, request.durationDays);

  const allocation = await databaseAdapter.transaction("quickPrepare.confirm", async (executor) => {
    /*
     * Re-select under lock. The preview the worker saw may be stale, and the
     * only stock that matters is the stock this transaction actually holds.
     */
    const candidates = await allocationRepository.lockCandidates(executor);

    /*
     * The duration rule is enforced HERE, under lock, not only in the preview.
     * M13 §1: "Do not rely only on a UI restriction. The same business rule must
     * be enforced server-side." The preview runs without locks and can be stale;
     * this is the only check whose answer is still true when the write happens.
     */
    const plan = buildAllocationPlan(candidates, request.profileCount, {
      requestedDurationDays: request.durationDays,
    });

    if (plan.isShort) {
      /* Throwing rolls the transaction back and releases every lock. */
      throw shortStockError(plan);
    }

    /*
     * M13 §8, enforced against the accounts this transaction is ACTUALLY about
     * to allocate — not against whatever the preview showed.
     *
     * The client's flag is permission to proceed, never evidence that a change
     * is unnecessary: the requirement is re-derived here, inside the lock, so a
     * caller cannot skip it by omitting the field or by confirming against a
     * different account than the one it ends up with.
     */
    const reusedAccountIds = await executor
      .selectDistinct({ accountId: profiles.accountId })
      .from(profiles)
      .where(
        and(
          inArray(
            profiles.accountId,
            plan.slices.map((slice) => slice.account.id),
          ),
          sql`${profiles.expirationDate} is not null and ${profiles.expirationDate} < current_date`,
        ),
      );

    if (reusedAccountIds.length > 0 && request.passwordChangeConfirmed !== true) {
      throw new ValidationError("Password change not confirmed for a reused account", {
        userMessage:
          "One of these accounts previously belonged to another customer whose subscription " +
          "expired. Change the Netflix password and confirm you have done so before continuing.",
        fieldErrors: { passwordChangeConfirmed: "Confirm the password was changed" },
      });
    }

    /*
     * The credentials are produced BEFORE anything is written.
     *
     * A sale that cannot be delivered must not be committed. Decrypting here
     * means an undecryptable account fails the transaction while it still holds
     * only locks — no profile has been marked sold, no event written, nothing to
     * roll back — so a retry finds exactly the stock it started with.
     */
    const credentials = prepareCredentialsOrThrow(plan);

    const profileIds = plan.slices.flatMap((slice) => slice.profiles.map((profile) => profile.id));

    /*
     * One UPDATE for every profile in the sale rather than one per profile.
     * A five-profile order becomes a single statement.
     */
    await executor
      .update(profiles)
      .set({
        status: "sold",
        customerId: customer.id,
        workerId: context.actor?.id ?? null,
        saleDate,
        expirationDate,
        durationDays: request.durationDays,
        updatedAt: sql`now()`,
      })
      .where(inArray(profiles.id, profileIds));

    /* One INSERT for every event. */
    await executor.insert(profileEvents).values(
      plan.slices.flatMap((slice) =>
        slice.profiles.map((profile) => ({
          accountId: slice.account.id,
          profileId: profile.id,
          eventType: "sold" as const,
          userId: context.actor?.id ?? null,
          customerId: customer.id,
          metadata: {
            durationDays: request.durationDays,
            saleDate,
            expirationDate,
            profileNumber: profile.profileNumber,
          },
          ...(request.notes ? { notes: request.notes } : {}),
        })),
      ),
    );

    /*
     * Purchase bookends. ADR-007 Decision 2 defers the orders table, so these
     * are the only record of when this customer last bought anything.
     */
    await executor
      .update(customers)
      .set({
        lastPurchaseAt: sql`now()`,
        firstPurchaseAt: sql`coalesce(${customers.firstPurchaseAt}, now())`,
        updatedAt: sql`now()`,
      })
      .where(eq(customers.id, customer.id));

    return { plan, credentials };
  });

  if (!allocation.ok) {
    return allocation;
  }

  const { credentials } = allocation.value;

  for (const slice of allocation.value.plan.slices) {
    await auditService.recordOrWarn(
      {
        entity: "account",
        entityId: slice.account.id,
        action: "update",
        after: {
          event: "quick_prepare_allocation",
          customerId: customer.id,
          profileNumbers: slice.profiles.map((profile) => profile.profileNumber),
          durationDays: request.durationDays,
          expirationDate,
        },
      },
      context,
    );
  }

  return ok({
    customerId: customer.id,
    customerPhone: phone.value.normalized,
    whatsappUrl: phone.value.whatsappUrl,
    customerIsNew,
    expirationDate,
    durationDays: request.durationDays,
    /* The operator confirmed it; the result repeats it so it is not forgotten. */
    requiresPasswordChange: request.passwordChangeConfirmed === true,
    accounts: credentials,
    clipboardText: formatPreparation(
      credentials.map((account): AccountCredential => ({
        email: account.email,
        password: account.password,
        profiles: account.profiles.map((profile) => ({
          profileNumber: profile.profileNumber,
          pin: profile.pin,
          profileName: profile.profileName,
        })),
      })),
    ),
  });
}

/**
 * Commits a replacement the operator confirmed from a preview.
 *
 * The guarded entry point M13 §9 and §10 ask for. Everything `replaceAllocation`
 * does, plus the three checks that only make sense when a human has just been
 * shown a plan:
 *
 *   - the preview must still be true (nothing moved underneath it)
 *   - the password-change confirmation must be present when reuse was flagged
 *   - an already-expired allocation cannot be "replaced"
 *
 * All three are checked SERVER-SIDE. §10 is explicit that concurrency must not
 * be solved in React alone, and a Server Action is a POST endpoint anybody
 * holding a session can call directly.
 */
async function confirmReplacement(
  input: unknown,
  context: AuditContext,
): Promise<Result<PreparationResult>> {
  const parsed = confirmReplacementSchema.safeParse(input);

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues));
  }

  const {
    accountId,
    customerId,
    expectedProfileIds,
    replacementAccountId,
    reason,
    passwordChangeConfirmed,
  } = parsed.data;

  /*
   * Verify the preview before touching anything. If another operator replaced
   * this customer while the confirmation dialog sat open, the profiles they
   * were shown no longer belong to them — committing anyway is the "accidental
   * double replacement" §10 lists.
   */
  const current = await quickReplaceService.stillHolds(accountId, customerId, expectedProfileIds);

  if (!current.ok) {
    return current;
  }

  if (!current.value) {
    return fail(
      new ValidationError("The preview no longer matches the current allocation", {
        userMessage:
          "This allocation changed while you were reviewing it — someone may have already " +
          "replaced it. Look it up again before continuing.",
      }),
    );
  }

  /*
   * M13 §8 is NOT enforced here any more, deliberately.
   *
   * It used to be: this function called `quickReplaceService.preview()` — an
   * UNLOCKED read — and gated on the account that preview happened to pick. The
   * transaction then re-planned under lock and could legitimately choose a
   * DIFFERENT account. So the requirement was derived from one account and the
   * credentials handed over belonged to another: an account needing a password
   * change could be allocated without the operator ever being asked.
   *
   * The gate now lives inside the transaction, derived from the account the
   * commit actually locks. Quick Prepare's `confirm` has always done it that
   * way; this path now matches it. See `commitReplacement`.
   */
  const outcome = await commitReplacement(
    {
      accountId,
      customerId,
      reason,
      replacementAccountId,
      expectedProfileIds,
      passwordChangeConfirmed,
    },
    context,
  );

  if (outcome.ok && passwordChangeConfirmed === true) {
    /* The confirmation is itself auditable, per §8. */
    await auditService.recordOrWarn(
      {
        entity: "account",
        entityId: accountId,
        action: "update",
        after: { event: "password_change_confirmed", customerId },
      },
      context,
    );
  }

  return outcome;
}

/**
 * What the shared release-and-reallocate transaction needs.
 *
 * `replacementAccountId` and `enforcePasswordGate` are what separate the
 * preview-backed path from the legacy Replace Account button. The button has no
 * preview and no confirmation checkbox, so it cannot supply either.
 */
/**
 * What the release-and-reallocate transaction needs.
 *
 * Every field is REQUIRED, and that is the point. These were optional while a
 * second, unguarded entry point existed — `replaceAllocation`, which supplied
 * none of them — so each guard below had to be written as "enforce this only if
 * the caller opted in". That is a bypass with extra steps.
 *
 * `confirmReplacement` is now the only caller, so the guards are unconditional
 * and the type makes a guardless call unrepresentable rather than merely
 * discouraged.
 */
interface CommitReplacementOptions {
  readonly accountId: string;
  readonly customerId: string;
  readonly reason?: string | undefined;
  /** The exact account the operator approved. */
  readonly replacementAccountId: string;
  /** Profiles the preview showed, re-verified under lock. */
  readonly expectedProfileIds: readonly string[];
  readonly passwordChangeConfirmed?: boolean | undefined;
}

/** The release-and-reallocate transaction. One caller: `confirmReplacement`. */
async function commitReplacement(
  {
    accountId,
    customerId,
    reason,
    replacementAccountId,
    expectedProfileIds,
    passwordChangeConfirmed,
  }: CommitReplacementOptions,
  context: AuditContext,
): Promise<Result<PreparationResult>> {
  const customerRow = await databaseAdapter.query("quickPrepare.readCustomer", (executor) =>
    executor.select().from(customers).where(eq(customers.id, customerId)).limit(1),
  );

  if (!customerRow.ok) {
    return customerRow;
  }

  const customer = customerRow.value[0];

  if (!customer) {
    return fail(
      new ValidationError("Customer not found for replacement", {
        userMessage: "That customer no longer exists.",
      }),
    );
  }

  const now = new Date();

  const replacement = await databaseAdapter.transaction(
    "quickPrepare.replace",
    async (executor) => {
      /* The profiles this customer currently holds on the failing account. */
      const held = await executor
        .select()
        .from(profiles)
        .where(and(eq(profiles.accountId, accountId), eq(profiles.customerId, customerId)))
        .for("update");

      if (held.length === 0) {
        throw new ValidationError("No profiles held by this customer on that account", {
          userMessage: "This customer does not hold any profiles on that account.",
        });
      }

      const first = held[0];

      if (!first) {
        throw new ValidationError("No profiles to replace");
      }

      /*
       * The preview must still describe reality, checked HERE rather than only
       * before the transaction opened. `stillHolds` runs unlocked and can go
       * stale in the moment between that read and this lock; these rows are the
       * ones this transaction holds.
       */
      const currentlyHeld = new Set(held.map((profile) => profile.id));

      const previewStillTrue =
        currentlyHeld.size === expectedProfileIds.length &&
        expectedProfileIds.every((id) => currentlyHeld.has(id));

      if (!previewStillTrue) {
        throw new ValidationError("The preview no longer matches the current allocation", {
          userMessage:
            "This allocation changed while you were reviewing it — someone may have already " +
            "replaced it. Look it up again before continuing.",
        });
      }

      /*
       * M13 §10: an already-expired allocation cannot be replaced. There is
       * nothing left to carry over, and moving zero remaining days onto fresh
       * stock would consume a profile to give the customer nothing. They need a
       * new sale through Quick Prepare, not a replacement.
       */
      const stillRunning = held.some(
        (profile) => (remainingDays(profile.expirationDate, now) ?? 0) >= 0,
      );

      if (!stillRunning) {
        throw new ValidationError("Every held profile has already expired", {
          userMessage:
            "This customer's subscription has already expired, so there is nothing to " +
            "replace. Prepare a new subscription instead.",
        });
      }

      /*
       * Carry the original terms forward. The customer bought a duration, and a
       * replacement is a fix for our problem, not a new sale — restarting the
       * clock would silently extend it and lose the real expiry.
       */
      const durationDays = first.durationDays ?? 30;
      const expirationDate = first.expirationDate ?? computeExpirationDate(now, durationDays);
      const saleDate = first.saleDate ?? todayAsDate(now);

      /*
       * What the customer still has coming, in whole days. M13 §9: a
       * replacement preserves the remaining period rather than restarting it —
       * 90 bought, 40 consumed, 50 carried over. The absolute expiration_date
       * below is what actually preserves it; this number is what the
       * REPLACEMENT account must be able to cover.
       */
      const remainingForCustomer = Math.max(remainingDays(expirationDate, now) ?? durationDays, 0);

      const candidates = await allocationRepository.lockCandidates(executor);

      /* Never replace like for like — the failing account must not win again. */
      const eligible = candidates.filter((candidate) => candidate.account.id !== accountId);

      /*
       * M13 §9/§10: commit the account the operator approved, or nothing.
       *
       * `lockCandidates` has already re-applied every eligibility rule under
       * lock — healthy, not deleted, no blocking problem, account still covered,
       * slot sellable, profile free. Narrowing to the requested id therefore
       * asks "is the approved account still eligible?" using exactly those
       * rules, with the rows locked.
       *
       * Narrowing rather than searching is the point: if the approved account is
       * gone, this list is empty and the commit REFUSES. It must never quietly
       * fall through to whatever else the engine would have ranked first — the
       * operator approved a specific account, possibly after changing its
       * password by hand.
       */
      const targeted = eligible.filter(
        (candidate) => candidate.account.id === replacementAccountId,
      );

      if (targeted.length === 0) {
        throw new ValidationError("The approved replacement account is no longer eligible", {
          userMessage:
            "The replacement account you approved is no longer available — it may have been " +
            "taken, developed a problem, or run out of validity. Look the customer up again.",
        });
      }

      /*
       * A replacement that expires before the customer does is not a
       * replacement. Enforced under lock, with the same rule and the same
       * engine Quick Prepare uses — there is no second allocation path.
       */
      const plan = buildAllocationPlan(targeted, held.length, {
        requestedDurationDays: remainingForCustomer,
      });

      if (plan.isShort) {
        throw shortStockError(plan);
      }

      /*
       * The invariant, asserted rather than assumed:
       *
       *   approved account === planned account === committed account
       *
       * `targeted` already makes drift impossible, so this can only fire if the
       * engine is changed to widen its own input. That is precisely when a
       * silent substitution would otherwise reappear.
       */
      if (plan.slices.some((slice) => slice.account.id !== replacementAccountId)) {
        throw new ValidationError("Replacement drifted from the approved account", {
          userMessage:
            "Something went wrong selecting the replacement. Look the customer up again.",
        });
      }

      /*
       * M13 §8, derived from the LOCKED account this transaction is actually
       * about to hand over — never from the unlocked preview, and never from a
       * flag the client sent.
       *
       * The client's `passwordChangeConfirmed` is permission to proceed, not
       * evidence that a change was unnecessary: the requirement itself is
       * recomputed here, so a caller cannot escape the gate by omitting the
       * field, by sending false, or by confirming against a different account
       * than the one it ends up with. Same shape as `confirm` above.
       */
      const chosenAccountIds = [...new Set(plan.slices.map((slice) => slice.account.id))];

      const lapsed = await executor
        .selectDistinct({ accountId: profiles.accountId })
        .from(profiles)
        .where(
          and(
            inArray(profiles.accountId, chosenAccountIds),
            sql`${profiles.expirationDate} is not null and ${profiles.expirationDate} < current_date`,
          ),
        );

      const requiresPasswordChange = lapsed.length > 0;

      if (requiresPasswordChange && passwordChangeConfirmed !== true) {
        throw new ValidationError("Password change not confirmed for a reused account", {
          userMessage:
            "This account previously belonged to another customer. Change the Netflix password " +
            "and confirm you have done so before handing it over.",
          fieldErrors: { passwordChangeConfirmed: "Confirm the password was changed" },
        });
      }

      /*
       * Credentials BEFORE the release, for the same reason as in `confirm`.
       *
       * A replacement whose credentials cannot be produced must not release the
       * customer's working allocation. Failing here leaves them exactly where
       * they were, holding profiles they can still use, instead of moving them
       * onto an account nobody can read the password for.
       */
      const credentials = prepareCredentialsOrThrow(plan);

      /* Release the old profiles. Available requires no customer — see the check constraint. */
      await executor
        .update(profiles)
        .set({
          status: "available",
          customerId: null,
          workerId: null,
          saleDate: null,
          expirationDate: null,
          durationDays: null,
          updatedAt: sql`now()`,
        })
        .where(
          inArray(
            profiles.id,
            held.map((profile) => profile.id),
          ),
        );

      /* The cancellation is history and must be recorded before the new sale. */
      await executor.insert(profileEvents).values(
        held.map((profile) => ({
          accountId,
          profileId: profile.id,
          eventType: "replaced" as const,
          userId: context.actor?.id ?? null,
          customerId,
          metadata: {
            outcome: "cancelled",
            reason: reason ?? "account_problem",
            profileNumber: profile.profileNumber,
          },
        })),
      );

      const newProfileIds = plan.slices.flatMap((slice) =>
        slice.profiles.map((profile) => profile.id),
      );

      await executor
        .update(profiles)
        .set({
          status: "sold",
          customerId,
          workerId: context.actor?.id ?? null,
          saleDate,
          expirationDate,
          durationDays,
          updatedAt: sql`now()`,
        })
        .where(inArray(profiles.id, newProfileIds));

      await executor.insert(profileEvents).values(
        plan.slices.flatMap((slice) =>
          slice.profiles.map((profile) => ({
            accountId: slice.account.id,
            profileId: profile.id,
            eventType: "replaced" as const,
            userId: context.actor?.id ?? null,
            customerId,
            metadata: {
              outcome: "reallocated",
              replacesAccountId: accountId,
              profileNumber: profile.profileNumber,
              expirationDate,
            },
          })),
        ),
      );

      return { plan, expirationDate, durationDays, requiresPasswordChange, credentials };
    },
  );

  if (!replacement.ok) {
    return replacement;
  }

  const { credentials } = replacement.value;

  await auditService.recordOrWarn(
    {
      entity: "account",
      entityId: accountId,
      action: "update",
      after: {
        event: "quick_prepare_replacement",
        customerId,
        reason: reason ?? "account_problem",
        replacedWith: replacement.value.plan.slices.map((slice) => slice.account.id),
      },
    },
    context,
  );

  return ok({
    customerId,
    customerPhone: customer.phoneNormalized,
    whatsappUrl: customer.whatsappUrl,
    customerIsNew: false,
    expirationDate: replacement.value.expirationDate,
    durationDays: replacement.value.durationDays,
    /*
     * Derived under lock inside the transaction, and reported afterwards for
     * the same reason `confirm` reports it: the result screen is where an
     * operator verifies they really did change the password before sending the
     * credentials on.
     */
    requiresPasswordChange: replacement.value.requiresPasswordChange,
    accounts: credentials,
    clipboardText: formatPreparation(
      credentials.map((account): AccountCredential => ({
        email: account.email,
        password: account.password,
        profiles: account.profiles.map((profile) => ({
          profileNumber: profile.profileNumber,
          pin: profile.pin,
          profileName: profile.profileName,
        })),
      })),
    ),
  });
}

/**
 * Decrypts the credentials for a plan, INSIDE the transaction that allocates it.
 *
 * This used to run after COMMIT, on the reasoning that decryption is CPU work
 * with no bearing on the outcome and should not hold profile locks. Both halves
 * of that were wrong.
 *
 * It does have a bearing on the outcome. A sale whose credentials cannot be
 * produced is a sale that cannot be delivered, and committing it anyway left the
 * operator looking at a generic error while the profiles were gone. In Quick
 * Prepare they would retry, and every retry consumed more stock — three profiles
 * disappeared that way during Phase D before anyone understood why.
 *
 * And the lock cost is nil. AES-256-GCM over a short string is microseconds, on
 * a ciphertext already in memory from `lockCandidates`; the transaction around
 * it already spans several database round trips of ~500ms each. Trading
 * microseconds of lock time for "a committed sale is always deliverable" is not
 * a close call.
 *
 * Throws rather than returning a Result: inside a transaction callback, throwing
 * is what triggers the rollback. `UnexpectedError` carries no SQLSTATE and is in
 * neither retry list, so the adapter fails it once rather than re-running the
 * whole transaction against a ciphertext that will never decrypt.
 *
 * Called BEFORE any write, so a failure leaves nothing to roll back at all.
 */
function prepareCredentialsOrThrow(plan: AllocationPlan): readonly PreparedAccount[] {
  return plan.slices.map((slice) => {
    const password = decryptSecret(slice.account.passwordEncrypted);

    if (!password.ok) {
      throw password.error;
    }

    return {
      accountId: slice.account.id,
      email: slice.account.email,
      password: password.value,
      profiles: slice.profiles.map((profile) => ({
        profileId: profile.id,
        profileNumber: profile.profileNumber,
        profileName: profile.profileName,
        pin: profile.pin,
      })),
    };
  });
}

/** Reads current allocatable stock, for the page header. */
async function availableStock(): Promise<Result<number>> {
  return allocationRepository.countAvailable();
}

function toValidationError(
  issues: readonly { path: PropertyKey[]; message: string }[],
): ValidationError {
  const fieldErrors: Record<string, string> = {};

  for (const issue of issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !(field in fieldErrors)) {
      fieldErrors[field] = issue.message;
    }
  }

  return new ValidationError("Quick Prepare input failed validation", { fieldErrors });
}

export const quickPrepareService = {
  preview,
  confirm,
  /**
   * The ONLY replacement entry point. M13 §9 and §10.
   *
   * `replaceAllocation` used to sit beside it, committing without a bound
   * replacement account and without the password-change gate. Both entry points
   * reached the same transaction, so the safe one was only ever a convention.
   * It was deleted; this is the single guarded path.
   */
  confirmReplacement,
  availableStock,
} as const;
