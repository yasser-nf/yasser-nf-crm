import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";
import { accountCanAllocate, profileCellState, type ProfileCellState } from "@/modules/accounts";

/**
 * Dashboard profile counts, by the SAME rule every profile badge uses.
 *
 * M01 finding F5: the Profiles widget counted `expiring_soon` and `expired`
 * from `profiles.status` — enum values nothing in the application writes. On
 * the day of the audit it showed 0 and 0 while six allocations had in fact
 * expired and four were expiring, and the Expirations widget beside it (which
 * reads `expiration_date`) showed the real numbers. Two widgets, one page, two
 * answers.
 *
 * The fix is not a better SQL expression. It is to stop having a second rule.
 * Each profile is classified by `profileCellState` — the function behind the
 * Accounts table, the account detail page, the profile cards and Quick Replace
 * — with `accountCanAllocate` supplying its fourth argument exactly as those
 * screens supply it. So "expired" on the dashboard now means precisely what a
 * red chip on the Accounts page means, and cannot drift from it.
 *
 * Pure: no I/O, no clock of its own. The caller passes `today`, so one render
 * cannot straddle midnight and a test can pin the date.
 */

/** The account fields the shared rules read. Deliberately not the full row. */
export type ProfileStateAccount = Pick<
  AccountRow,
  "profileSlots" | "validUntil" | "status" | "deletedAt"
>;

export interface ProfileStateInput {
  readonly profile: ProfileRow;
  readonly account: ProfileStateAccount;
  /** An open, in-progress or waiting issue on the account — BLOCKING_STATUSES. */
  readonly hasBlockingProblem: boolean;
}

export type ProfileStateTally = Readonly<Record<ProfileCellState, number>>;

const EMPTY: Record<ProfileCellState, number> = {
  sold: 0,
  expiring_soon: 0,
  available: 0,
  expired: 0,
  not_for_sale: 0,
  blocked: 0,
};

/**
 * Counts profiles by display state.
 *
 * Every profile lands in exactly one bucket, because `profileCellState` returns
 * exactly one state — so the buckets are disjoint and sum to the total by
 * construction, which is the property the old stored-status counts lacked.
 */
export function tallyProfileStates(
  inputs: readonly ProfileStateInput[],
  today: Date,
): ProfileStateTally {
  const tally = { ...EMPTY };

  for (const { profile, account, hasBlockingProblem } of inputs) {
    const canAllocate = accountCanAllocate(account, hasBlockingProblem, today);
    const state = profileCellState(profile, account, today, canAllocate);

    tally[state] += 1;
  }

  return tally;
}
