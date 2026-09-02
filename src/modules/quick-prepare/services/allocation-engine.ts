import { addDays, todayAsDateString } from "@/lib/dates";
import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";
import type { AllocationCandidate } from "../repositories/allocation.repository";

/**
 * The Smart Stock allocation engine.
 *
 * Deliberately pure: it takes candidates and a quantity, and returns a plan. No
 * database, no clock, no randomness. 02_ARCHITECTURE.md requires business logic
 * to be testable without rendering React or touching a connection, and this is
 * the piece most worth testing.
 *
 * 01_MASTER_RULES.md forbids taking the first available account and requires a
 * score. ADR-007 Decision 1 settles what a good score means here: concentration.
 *
 * The ordering is total, so two runs over the same stock always produce the same
 * plan. An engine that allocates differently on each call is impossible to
 * reason about when a customer complains.
 */

export interface AllocationSlice {
  readonly account: AccountRow;
  readonly profiles: readonly ProfileRow[];
}

/**
 * An account that had free profiles but could not serve THIS request.
 *
 * Carried out of the engine so the failure can be explained with numbers. The
 * M13 Phase B approval asks for exactly this: not just a blocked reason, but
 * "Only 18 days remaining. Customer requested 90 days."
 */
export interface RejectedCandidate {
  readonly accountId: string;
  readonly email: string;
  readonly freeProfiles: number;
  readonly remainingDays: number | null;
  readonly requestedDays: number;
}

export interface AllocationPlan {
  readonly slices: readonly AllocationSlice[];
  readonly allocated: number;
  readonly requested: number;
  /** True when stock could not cover the request. Nothing is allocated then. */
  readonly isShort: boolean;
  /** Profiles the engine was allowed to consider, after validity filtering. */
  readonly availableTotal: number;
  /**
   * Profiles that existed but were excluded for insufficient account validity.
   *
   * Separated from availableTotal so a shortfall can distinguish "there is no
   * stock" from "there is stock, but none of it lasts long enough" — two
   * problems with completely different answers for the operator.
   */
  readonly excludedForValidity: number;
  readonly rejected: readonly RejectedCandidate[];
}

/** Options that make the plan duration-aware. Omit for a pure count-based plan. */
export interface PlanOptions {
  /**
   * The subscription length being sold.
   *
   * When given, an account whose remaining validity cannot cover it is excluded
   * — 01_MASTER_RULES.md via M13 §1: an allocation must never outlive the
   * account carrying it. When omitted the engine behaves exactly as it did
   * before M13, which is what the preview count uses.
   */
  readonly requestedDurationDays?: number | undefined;
}

/**
 * Remaining validity below which an account is heavily deprioritised.
 *
 * Defined here because scoring is the only thing that uses it. The hard rule —
 * can this account cover the request at all — lives in account-validity.ts and
 * is a different question: this threshold NEVER rejects anything.
 *
 * From the M13 Phase B approval: "Accounts nearing expiration should not
 * immediately disappear... Quick Prepare only chooses them if no better account
 * exists. Only reject when remaining validity is insufficient."
 */
export const NEAR_EXPIRY_DAYS = 15;

/**
 * How desirable an account is for a request of `remaining` profiles.
 *
 * Higher is better. The factors, in the order they dominate:
 *
 *   1. Can it finish the job alone?  A single account that covers the whole
 *      request beats any combination, because the customer then receives one
 *      email and one password instead of several.
 *
 *   2. Is it already partly sold?    Filling a partly-used account leaves
 *      untouched accounts whole. Five accounts holding one free profile each
 *      cannot serve a customer wanting two; one account holding five serves
 *      anyone.
 *
 *   3. Health score.                 Among equals, the healthiest account.
 *
 *   4. Least waste.                  Prefer the account whose free capacity most
 *      closely matches what is still needed, so large blocks stay intact.
 *
 * M13 adds a penalty rather than a fifth factor. An account with days left to
 * run is still perfectly good stock — it just should not be spent while
 * something longer-lived would do. So it is pushed down the order, not out of
 * it, and it still wins when it is the only thing that fits.
 */
function scoreCandidate(candidate: AllocationCandidate, remaining: number): number {
  const free = candidate.availableProfiles.length;

  /*
   * Weights are spaced by an order of magnitude so a lower factor can never
   * outrank a higher one.
   *
   * There used to be a health term here, `healthScore * 100`. The column it
   * read was never calculated and held its default of 100 for every account,
   * so the term was the same constant for every candidate and could not order
   * anything. Removing it leaves the ranking numerically identical.
   *
   * Health as a rule has not gone anywhere: an unhealthy account or one with an
   * open problem never becomes a candidate in the first place, because the
   * eligibility query and `evaluateAllocation` both apply
   * `accounts.status = healthy AND no blocking problem`.
   */
  const coversRequest = free >= remaining ? 1_000_000 : 0;
  const partiallySold = candidate.soldCount > 0 ? 100_000 : 0;

  /*
   * Sized to outrank every preference below it — partial-sale concentration
   * (100_000) cannot pull a nearly-expired account back above a healthy one. It sits BELOW coversRequest on purpose:
   * an account that can serve the whole order alone is still worth choosing,
   * because splitting a customer across two accounts to save a few days of
   * shelf life is a worse outcome for them.
   */
  const nearExpiryPenalty = isNearExpiry(candidate) ? 500_000 : 0;

  /*
   * Waste is how much capacity is left untouched after taking what is needed.
   * Subtracted, so a tighter fit scores higher.
   */
  const waste = Math.max(free - remaining, 0);

  return coversRequest + partiallySold - nearExpiryPenalty - waste;
}

/** Short-dated but still usable. Null validity is open-ended and never near expiry. */
function isNearExpiry(candidate: AllocationCandidate): boolean {
  const days = candidate.remainingValidityDays;
  return days !== null && days >= 0 && days < NEAR_EXPIRY_DAYS;
}

/**
 * Whether this account can carry a subscription of the requested length.
 *
 * The hard rule from M13 §1: requested_duration_days <= account_remaining_days.
 * Open-ended coverage (null) carries anything.
 */
function canCover(candidate: AllocationCandidate, requestedDurationDays: number): boolean {
  const days = candidate.remainingValidityDays;
  return days === null || days >= requestedDurationDays;
}

/**
 * Builds an allocation plan.
 *
 * Greedy by design. The optimal bin-packing answer is NP-hard, and the input is
 * tiny — accounts hold at most five profiles, and a request is a handful. Greedy
 * with this ordering produces the minimum account count in every realistic case
 * and runs in microseconds, which matters because 01_MASTER_RULES.md targets
 * Quick Prepare under five seconds end to end.
 */
export function buildAllocationPlan(
  candidates: readonly AllocationCandidate[],
  requested: number,
  options: PlanOptions = {},
): AllocationPlan {
  const requestedDays = options.requestedDurationDays;

  /*
   * Validity filtering happens BEFORE anything is counted, so availableTotal
   * reports what could actually be sold for this duration rather than raw free
   * capacity. A worker told "8 profiles available" who then cannot buy any of
   * them for 90 days has been told something worse than nothing.
   */
  const eligible =
    requestedDays === undefined
      ? [...candidates]
      : candidates.filter((candidate) => canCover(candidate, requestedDays));

  const rejected: RejectedCandidate[] =
    requestedDays === undefined
      ? []
      : candidates
          .filter((candidate) => !canCover(candidate, requestedDays))
          .map((candidate) => ({
            accountId: candidate.account.id,
            email: candidate.account.email,
            freeProfiles: candidate.availableProfiles.length,
            remainingDays: candidate.remainingValidityDays,
            requestedDays,
          }));

  const excludedForValidity = rejected.reduce(
    (total, candidate) => total + candidate.freeProfiles,
    0,
  );

  const availableTotal = eligible.reduce(
    (total, candidate) => total + candidate.availableProfiles.length,
    0,
  );

  if (requested <= 0 || availableTotal < requested) {
    return {
      slices: [],
      allocated: 0,
      requested,
      /*
       * All or nothing. Handing a worker three profiles when they asked for five
       * would send a customer a partial order that looks complete.
       */
      isShort: true,
      availableTotal,
      excludedForValidity,
      rejected,
    };
  }

  const pool = eligible;
  const slices: AllocationSlice[] = [];
  let remaining = requested;

  while (remaining > 0 && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < pool.length; index += 1) {
      const candidate = pool[index];

      if (!candidate) {
        continue;
      }

      const score = scoreCandidate(candidate, remaining);

      /*
       * Strictly greater, so the first candidate wins a tie. The pool arrives
       * pre-sorted by health then age, which makes ties resolve deterministically
       * rather than by whichever row the database returned first.
       */
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    const chosen = pool.splice(bestIndex, 1)[0];

    if (!chosen) {
      break;
    }

    /* Lowest profile numbers first, so a customer's profiles read 1, 2, 3. */
    const take = Math.min(remaining, chosen.availableProfiles.length);
    const taken = [...chosen.availableProfiles]
      .sort((left, right) => left.profileNumber - right.profileNumber)
      .slice(0, take);

    slices.push({ account: chosen.account, profiles: taken });
    remaining -= taken.length;
  }

  const allocated = requested - remaining;

  return {
    slices,
    allocated,
    requested,
    isShort: allocated < requested,
    availableTotal,
    excludedForValidity,
    rejected,
  };
}

/**
 * Computes an expiration date.
 *
 * Whole days on a `date` column, deliberately: a timezone on a subscription
 * boundary produces off-by-one expiries at midnight, and a customer whose
 * service ends a day early does not care that the cause was a timezone.
 *
 * Delegates to lib/dates since M13. The arithmetic used to live here and was
 * copied in customer-status.ts; M13 compares the two against each other, and
 * two subtly different subtractions would produce a boundary bug that appears
 * on one day and vanishes.
 */
export function computeExpirationDate(saleDate: Date, durationDays: number): string {
  return addDays(saleDate, durationDays);
}

/** Today as a `date` string, in the same UTC frame as expiry. */
export function todayAsDate(now: Date): string {
  return todayAsDateString(now);
}
