/**
 * Whole-day date arithmetic.
 *
 * Three modules had grown their own copy of this by M13 — customer status,
 * the allocation engine, and then account validity would have been a fourth.
 * They agreed, but only by coincidence, and M13 adds a rule that compares a
 * customer's remaining days against an account's remaining days. Two subtly
 * different subtractions there would produce an off-by-one that sells a
 * subscription the account cannot cover, on exactly one day in the boundary
 * case, which is the hardest kind of bug to ever see again.
 *
 * Everything here is pure and takes its clock as an argument. Nothing calls
 * `new Date()` on its own, so every caller is testable without mocking time.
 *
 * The unit is the whole day, and every function reduces both sides to UTC
 * midnight before comparing. A subscription boundary that depends on the time
 * of day produces expiries that flip at midnight in a timezone nobody chose.
 */

/** A `YYYY-MM-DD` string, matching the `date` columns these values come from. */
export type DateString = string;

/**
 * Whole days from `today` until `target`. Negative once past.
 *
 * Returns null for a null input — meaning "no boundary recorded", which is
 * open-ended rather than expired. Callers must not collapse that to 0: an
 * account with no valid_until can serve any duration, and reading it as zero
 * days remaining would reject every allocation against it.
 */
export function remainingDays(target: DateString | null, today: Date): number | null {
  if (!target) {
    return null;
  }

  const parsed = Date.parse(`${target}T00:00:00Z`);

  if (Number.isNaN(parsed)) {
    return null;
  }

  const midnightToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  return Math.round((parsed - midnightToday) / 86_400_000);
}

/** Today, in the same UTC frame every comparison here uses. */
export function todayAsDateString(now: Date): DateString {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

/**
 * `from` plus a whole number of days.
 *
 * Built through Date.UTC and setUTCDate so month and year rollover, and leap
 * days, are the platform's problem rather than this function's.
 */
export function addDays(from: Date, days: number): DateString {
  const shifted = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));

  shifted.setUTCDate(shifted.getUTCDate() + days);

  return shifted.toISOString().slice(0, 10);
}

/**
 * Whether a boundary has already passed.
 *
 * A null boundary is NOT past — it is absent. This is the single most
 * load-bearing null check in the M13 validity rules: every account created
 * before M13 has a null valid_until, and treating those as expired would take
 * the entire existing inventory out of circulation.
 */
export function isPast(boundary: DateString | null, today: Date): boolean {
  const days = remainingDays(boundary, today);
  return days !== null && days < 0;
}
