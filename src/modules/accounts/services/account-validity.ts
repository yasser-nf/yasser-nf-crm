import { addDays, isPast, remainingDays, type DateString } from "@/lib/dates";
import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";

/**
 * The narrowest shapes these rules actually need.
 *
 * Structural rather than `AccountRow`, so a projection that has dropped the
 * credential still satisfies them. The detail page and the accounts list both
 * pass an `AccountView` (no `passwordEncrypted`), and a validity rule has no
 * business requiring a password to be present in order to answer a question
 * about dates.
 */
type AccountValidity = Pick<AccountRow, "validUntil">;
type AccountSlots = Pick<AccountRow, "profileSlots">;
type ProfileSlot = Pick<ProfileRow, "profileNumber">;

/**
 * Account inventory validity and sellable slots.
 *
 * Pure. No database, no clock, no `server-only` — so it can be unit tested
 * directly and imported by the allocation engine, which is also pure.
 *
 * This file holds the M13 rules that are about an ACCOUNT as stock:
 *
 *   - how long the account itself can still serve anyone   (valid_until)
 *   - which of its five profile rows are sellable at all   (profile_slots)
 *   - whether a customer's allocation has run out          (expiration_date)
 *
 * The third one deserves its own note. 03_DATABASE.md states "Expired Profile →
 * Automatically Available if account is Healthy", and until M13 nothing
 * implemented it: no code ever wrote `expired` to profiles.status, so a sold
 * profile stayed sold forever and was never resold. That is fixed here, and
 * fixed by DERIVING it — `isAllocationExpired` reads expiration_date against
 * the clock rather than trusting a status column. No sweep job, no scheduled
 * task, nothing that can be late.
 *
 * Contrast `not_for_sale`, which IS stored. The line between them is the clock:
 * derive what time changes, store what an operator sets. ADR-013 D2.
 */

/**
 * Turns "90 days" into a coverage window.
 *
 * An operator buying stock thinks in durations; the allocation rule needs a
 * boundary date. Only ONE of them is stored — storing both would be duplicate
 * state that disagrees the moment either is edited, which 03_DATABASE.md
 * forbids. `duration_days` is therefore an input to this function and never a
 * column on accounts.
 *
 * An explicit valid_until always wins: a caller who named the date meant it.
 */
export function resolveValidity(
  input: {
    readonly validFrom?: string | undefined;
    readonly validUntil?: string | undefined;
    readonly durationDays?: number | undefined;
  },
  today: Date,
): { validFrom: DateString | null; validUntil: DateString | null } {
  const validFrom = input.validFrom ?? null;

  if (input.validUntil !== undefined) {
    return { validFrom, validUntil: input.validUntil };
  }

  if (input.durationDays === undefined) {
    /* Neither given. Open-ended, which is how every pre-M13 account behaves. */
    return { validFrom, validUntil: null };
  }

  /*
   * Counted from valid_from when one was given, otherwise from today. An
   * account bought to start next month should expire a duration after it
   * starts, not a duration after it was typed in.
   */
  const start = validFrom === null ? today : new Date(`${validFrom}T00:00:00Z`);

  return { validFrom, validUntil: addDays(start, input.durationDays) };
}

/** What is left on the account itself. Null means open-ended, never zero. */
export function accountRemainingDays(account: AccountValidity, today: Date): number | null {
  return remainingDays(account.validUntil, today);
}

/**
 * Whether the account's own coverage has run out.
 *
 * An account with no valid_until is open-ended and never expired. Every account
 * created before M13 is in exactly that state.
 */
export function isAccountExpired(account: AccountValidity, today: Date): boolean {
  return isPast(account.validUntil, today);
}

/**
 * Whether the account may sell anything at all, in TypeScript.
 *
 * The read-side twin of `accountCanAllocateSql`. The SQL form decides which
 * rows a query returns; this one decides what a slot already in hand is
 * labelled, and the two must agree or the list will paint a slot green that the
 * count in the same row excludes.
 *
 * `hasActiveProblem` is passed in rather than looked up: this module has no
 * business querying `issues`, and the callers already hold the answer from the
 * Problems module's public API.
 */
export function accountCanAllocate(
  account: AccountValidity & { readonly status: string; readonly deletedAt: Date | null },
  hasActiveProblem: boolean,
  today: Date,
): boolean {
  return (
    account.status === "healthy" &&
    account.deletedAt === null &&
    !hasActiveProblem &&
    !isAccountExpired(account, today)
  );
}

/**
 * The rule from M13 §1: requested_duration_days <= account_remaining_days.
 *
 * An open-ended account covers any duration. A duration of zero or less is not
 * a coverage question and is rejected by the input schema long before here.
 */
export function canCoverDuration(
  account: AccountValidity,
  requestedDurationDays: number,
  today: Date,
): boolean {
  const remaining = accountRemainingDays(account, today);

  if (remaining === null) {
    return true;
  }

  return remaining >= requestedDurationDays;
}

/**
 * Whether this profile row is stock at all.
 *
 * The ONLY definition of sellability in TypeScript, matching `isSellableSlotSql`
 * in lib/drizzle/predicates for queries. There is no stored status backing this:
 * a slot above profile_slots is still `available` at the column level and is
 * simply never selected.
 *
 * That is deliberate. A stored label would be a second source of truth for a
 * fact profile_slots already records, and `profileUpdateSchema` permits writing
 * `status` — so a profile update could return a parked slot to stock while
 * profile_slots still said otherwise, with no constraint able to object.
 * ADR-013 Decision 2.
 */
export function isSellableSlot(profile: ProfileSlot, account: AccountSlots): boolean {
  return profile.profileNumber <= account.profileSlots;
}

/**
 * Whether a customer's allocation has run out.
 *
 * The derived half of 03_DATABASE.md's recycling rule. Deliberately does not
 * look at profile.status: `expiring_soon` and `expired` are never written by
 * anything, so a status check here would answer "no" forever.
 */
export function isAllocationExpired(profile: ProfileRow, today: Date): boolean {
  return isPast(profile.expirationDate, today);
}

/**
 * Whether a profile row is free to be allocated, ignoring the account.
 *
 * Free means either never sold, or sold to somebody whose time has run out.
 * The second half is the recycling rule: 03_DATABASE.md says an expired profile
 * becomes available again on a healthy account, and this is where that becomes
 * true rather than aspirational.
 *
 * Says nothing about sellable slots — that is `isSellableSlot`, and callers need
 * both. `evaluateAllocation` applies them in order so the blocked reason names
 * the right one.
 */
export function isProfileFree(profile: ProfileRow, today: Date): boolean {
  if (profile.status === "available") {
    return true;
  }

  if (profile.status === "sold" || profile.status === "expiring_soon") {
    return isAllocationExpired(profile, today);
  }

  return false;
}

/**
 * What a profile looks like to an operator scanning a list.
 *
 *   sold          allocated and still inside the customer's window
 *   available     free stock, sellable right now
 *   expired       was allocated; the customer's window has closed
 *   not_for_sale  above accounts.profile_slots — never stock
 */
export type ProfileCellState = "sold" | "available" | "expired" | "not_for_sale" | "blocked";

/**
 * The single derivation behind every profile indicator in the application.
 *
 * Composes `isSellableSlot` and `isAllocationExpired` rather than restating
 * either. M13 §7 requires the accounts list, the account detail page, the
 * profile cards and Quick Prepare to agree, and they agree because they all end
 * up here.
 *
 * `profiles.status` is deliberately NOT the source of truth for expiry. Nothing
 * ever writes `expired`, so a status check would report "sold" for an allocation
 * that closed months ago. The date decides.
 *
 * Order matters and is itself the rule:
 *
 *   1. A slot outside profile_slots is not stock, whatever else is true of it.
 *   2. A past expiry outranks the stored status, because the status is stale.
 *   3. Only then does the stored status distinguish held from free.
 */
export function profileCellState(
  profile: ProfileRow,
  account: AccountSlots,
  today: Date,
  accountCanAllocate = true,
): ProfileCellState {
  if (!isSellableSlot(profile, account)) {
    return "not_for_sale";
  }

  if (isAllocationExpired(profile, today)) {
    return "expired";
  }

  if (
    profile.status === "sold" ||
    profile.status === "reserved" ||
    profile.status === "expiring_soon"
  ) {
    return "sold";
  }

  /*
   * Free, but the account cannot sell it — an open problem, a non-healthy
   * status, or expired coverage.
   *
   * Checked last, and only against a slot that would otherwise read "available".
   * A sold profile stays sold: the customer still holds it, and repainting their
   * allocation because the account has a fault would misreport reality. This
   * changes what the slot is offered as, never what it is.
   */
  if (!accountCanAllocate) {
    return "blocked";
  }

  return "available";
}

/**
 * Whether an allocation ending on `expirationDate` fits inside the account.
 *
 * The same rule Quick Prepare enforces as `requested <= remaining`, expressed
 * against an absolute date instead of a duration — because the profile editor
 * hands an operator a date picker, not a day count.
 *
 * Composes `accountRemainingDays` and `remainingDays`; it performs no
 * arithmetic of its own, so an allocation edited here and an allocation sold by
 * Quick Prepare are measured by the same ruler.
 *
 * An open-ended account fits anything. An allocation with no expiry fits
 * anything, because there is no boundary to exceed.
 */
export function allocationFitsAccount(
  account: AccountValidity,
  expirationDate: string | null,
  today: Date,
): boolean {
  const accountRemaining = accountRemainingDays(account, today);

  if (accountRemaining === null) {
    return true;
  }

  const allocationRemaining = remainingDays(expirationDate, today);

  if (allocationRemaining === null) {
    return true;
  }

  return allocationRemaining <= accountRemaining;
}

/**
 * The days a replacement must cover, for Quick Replace.
 *
 * M13 §9: a replacement preserves the remaining period rather than restarting
 * it. 90 days bought, 40 consumed, 50 carried over — not a fresh 90.
 *
 * Never negative: an allocation that already expired needs zero further days,
 * and returning a negative number here would make it trivially coverable by an
 * account that is itself expired.
 */
export function remainingCustomerDays(profile: ProfileRow, today: Date): number {
  const days = remainingDays(profile.expirationDate, today);

  if (days === null) {
    /* Open-ended allocation. Fall back to what was sold, or nothing. */
    return profile.durationDays ?? 0;
  }

  return Math.max(days, 0);
}
