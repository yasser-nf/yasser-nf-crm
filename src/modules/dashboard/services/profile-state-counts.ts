import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";
import { remainingDays } from "@/lib/dates";
import {
  accountCanAllocate,
  isProfileFree,
  isSellableSlot,
  profileCellState,
  type ProfileCellState,
} from "@/modules/accounts";

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

/**
 * Upcoming and past expirations, in disjoint buckets (M04).
 *
 * Built on the same classification as the tally above, so the two widgets
 * cannot disagree:
 *
 *   expired         exactly the tally's `expired` — a lapsed allocation
 *   today           a held allocation (sold / expiring soon) ending today
 *   tomorrow        … ending tomorrow
 *   inTwoToThree    … ending in 2 or 3 days
 *   inFourToSeven   … ending in 4 to 7 days
 *
 * today + tomorrow + inTwoToThree equals the tally's `expiring_soon`, because
 * EXPIRING_SOON_DAYS is 3 and `profileCellState` uses the same `remainingDays`.
 * The buckets used to be cumulative ("within 3" contained "tomorrow") and
 * counted any profile carrying a date — a free slot included — from the
 * database's own `current_date`. Days are now counted in UTC, like every other
 * date rule in the application.
 */
export interface ExpirationTally {
  readonly expired: number;
  readonly today: number;
  readonly tomorrow: number;
  readonly inTwoToThree: number;
  readonly inFourToSeven: number;
}

export function expirationBuckets(
  inputs: readonly ProfileStateInput[],
  today: Date,
): ExpirationTally {
  const buckets = { expired: 0, today: 0, tomorrow: 0, inTwoToThree: 0, inFourToSeven: 0 };

  for (const { profile, account, hasBlockingProblem } of inputs) {
    const state = profileCellState(
      profile,
      account,
      today,
      accountCanAllocate(account, hasBlockingProblem, today),
    );

    if (state === "expired") {
      buckets.expired += 1;
      continue;
    }

    if (state !== "sold" && state !== "expiring_soon") {
      continue;
    }

    const days = remainingDays(profile.expirationDate, today);

    if (days === 0) buckets.today += 1;
    else if (days === 1) buckets.tomorrow += 1;
    else if (days !== null && days >= 2 && days <= 3) buckets.inTwoToThree += 1;
    else if (days !== null && days >= 4 && days <= 7) buckets.inFourToSeven += 1;
  }

  return buckets;
}

/**
 * Expired allocations Quick Prepare can resell right now.
 *
 * 03_DATABASE.md: "Expired Profile → Automatically Available if account is
 * Healthy". So stock (what Quick Prepare may sell) is the Profiles widget's
 * Available PLUS these — the one legitimate place the display buckets and the
 * stock figure differ. Composed from the shared rules; no arithmetic of its own.
 */
export function resellableExpired(inputs: readonly ProfileStateInput[], today: Date): number {
  let count = 0;

  for (const { profile, account, hasBlockingProblem } of inputs) {
    const canAllocate = accountCanAllocate(account, hasBlockingProblem, today);

    if (
      canAllocate &&
      profileCellState(profile, account, today, canAllocate) === "expired" &&
      isSellableSlot(profile, account) &&
      isProfileFree(profile, today)
    ) {
      count += 1;
    }
  }

  return count;
}
