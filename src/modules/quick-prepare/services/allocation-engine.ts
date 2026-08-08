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

export interface AllocationPlan {
  readonly slices: readonly AllocationSlice[];
  readonly allocated: number;
  readonly requested: number;
  /** True when stock could not cover the request. Nothing is allocated then. */
  readonly isShort: boolean;
  readonly availableTotal: number;
}

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
 */
function scoreCandidate(candidate: AllocationCandidate, remaining: number): number {
  const free = candidate.availableProfiles.length;

  /*
   * Weights are spaced by an order of magnitude so a lower factor can never
   * outrank a higher one. Health (0-100) cannot overturn "covers the request".
   */
  const coversRequest = free >= remaining ? 1_000_000 : 0;
  const partiallySold = candidate.soldCount > 0 ? 100_000 : 0;
  const health = candidate.account.healthScore * 100;

  /*
   * Waste is how much capacity is left untouched after taking what is needed.
   * Subtracted, so a tighter fit scores higher.
   */
  const waste = Math.max(free - remaining, 0);

  return coversRequest + partiallySold + health - waste;
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
): AllocationPlan {
  const availableTotal = candidates.reduce(
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
    };
  }

  const pool = [...candidates];
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
  };
}

/**
 * Computes an expiration date.
 *
 * Whole days on a `date` column, deliberately: a timezone on a subscription
 * boundary produces off-by-one expiries at midnight, and a customer whose
 * service ends a day early does not care that the cause was a timezone.
 */
export function computeExpirationDate(saleDate: Date, durationDays: number): string {
  const expiry = new Date(
    Date.UTC(saleDate.getUTCFullYear(), saleDate.getUTCMonth(), saleDate.getUTCDate()),
  );

  expiry.setUTCDate(expiry.getUTCDate() + durationDays);

  return expiry.toISOString().slice(0, 10);
}

/** Today as a `date` string, in the same UTC frame as expiry. */
export function todayAsDate(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}
