import type { AccountRow } from "@/lib/drizzle/schema";
import { accountEffectiveStatus, type AccountEffectiveStatus } from "@/modules/accounts";

/**
 * The dashboard's account buckets, by the SAME rule as every account badge (M04).
 *
 * Each live account is classified by `accountEffectiveStatus` — the function
 * behind the Accounts list, the account page and the CSV export since M03 —
 * and then grouped:
 *
 *   healthy   effective "healthy", which is exactly `accountCanAllocate`
 *   problems  effective fault: a blocking problem (named or mixed), or a fault
 *             recorded on the account itself
 *   expired   effective "expired": no problem, but its own validity has ended
 *   archived  effective "archived"
 *
 * Every account lands in exactly one bucket, so the buckets are disjoint and
 * sum to the total by construction. Soft-deleted accounts are not passed in:
 * the dashboard, like the Accounts page, counts accounts that exist.
 *
 * One consequence of reusing the M03 precedence, stated rather than hidden: an
 * ARCHIVED account that still carries an open problem is counted as Archived
 * here (its stored status names it first, as its badge does), while the
 * Problems widget's "accounts affected" still counts it — the problem is real.
 *
 * Pure: the caller supplies `today`.
 */

export interface AccountStateInput {
  readonly account: Pick<AccountRow, "status" | "validUntil" | "deletedAt">;
  /** Types of the account's blocking problems; empty when none. */
  readonly blockingProblemTypes: readonly string[];
}

export interface AccountStateTally {
  readonly total: number;
  readonly healthy: number;
  readonly problems: number;
  readonly expired: number;
  readonly archived: number;
}

export type AccountBucket = keyof Omit<AccountStateTally, "total">;

/** Which bucket an effective status belongs to. Exported so the grouping is asserted. */
export function accountBucket(effective: AccountEffectiveStatus): AccountBucket | null {
  switch (effective) {
    case "healthy":
      return "healthy";
    case "expired":
      return "expired";
    case "archived":
      return "archived";
    /* Excluded upstream; listed so the switch is exhaustive. */
    case "deleted":
      return null;
    default:
      /* payment_problem, incorrect_password, invalid_email, something_went_wrong, problem */
      return "problems";
  }
}

export function tallyAccountStates(
  inputs: readonly AccountStateInput[],
  today: Date,
): AccountStateTally {
  const tally = { total: 0, healthy: 0, problems: 0, expired: 0, archived: 0 };

  for (const { account, blockingProblemTypes } of inputs) {
    const bucket = accountBucket(accountEffectiveStatus(account, blockingProblemTypes, today));

    if (bucket === null) {
      continue;
    }

    tally.total += 1;
    tally[bucket] += 1;
  }

  return tally;
}
