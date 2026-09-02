/**
 * How an account row reads in words.
 *
 * Pure, and deliberately shared rather than duplicated: the accounts table and
 * the CSV export both show a Validity column, and an export whose numbers
 * disagree with the screen is worse than no export at all. Extracted from the
 * table for exactly that reason — it used to be a local function there.
 *
 * No arithmetic happens here. `remainingDays` arrives already computed by
 * `accountRemainingDays`, which is the one clock the whole application reads.
 */

/**
 * Remaining account validity, in words.
 *
 * Open-ended is stated rather than rendered as a dash, because an account with
 * no boundary is not the same as one expiring today, and showing "—" invites
 * the reader to supply their own meaning.
 */
export function validityLabel(remainingDays: number | null, validUntil: string | null): string {
  if (remainingDays === null || validUntil === null) {
    return "Open-ended";
  }

  if (remainingDays < 0) {
    return `Expired ${Math.abs(remainingDays)}d ago`;
  }

  if (remainingDays === 0) {
    return "Expires today";
  }

  return `${remainingDays}d left`;
}
