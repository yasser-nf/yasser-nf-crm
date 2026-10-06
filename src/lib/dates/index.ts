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

/**
 * Parses a `YYYY-MM-DD` string as UTC midnight.
 *
 * Explicitly UTC, and that is the whole point. `new Date("2026-09-01")` happens
 * to parse as UTC, but `new Date("2026-09-01T00:00:00")` parses as local time,
 * and the two differ by a day for anyone west of Greenwich. Both spellings look
 * equally reasonable in a diff, so the parse belongs here rather than at each
 * call site where a future edit could silently pick the wrong one.
 */
export function parseDateString(value: DateString | null): Date | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(`${value}T00:00:00Z`);

  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/**
 * `from` plus a whole number of days, both sides as `YYYY-MM-DD`.
 *
 * The string-in, string-out form of `addDays`, which is what both the profile
 * edit form and the profile service need: a `date` column and an
 * `<input type="date">` are both YYYY-MM-DD, and routing them through a Date
 * object at each call site is where a timezone bug gets in.
 *
 * Delegates to `addDays` rather than repeating the arithmetic, so month and
 * year rollover and leap days stay the platform's problem and there is only one
 * implementation to be right.
 *
 * Returns null when the date cannot be parsed, so a malformed value surfaces as
 * "no expiration" rather than as `Invalid Date` written to a date column.
 */
export function addDaysToDateString(from: DateString | null, days: number): DateString | null {
  const parsed = parseDateString(from);

  return parsed === null ? null : addDays(parsed, days);
}

/**
 * How close to expiry counts as "expiring soon".
 *
 * Three days, which is the highlight M05 specifies and the window
 * `expiryUrgency` has always used for the customer screens. Named here rather
 * than repeated as a literal so the profile badges and the customer badges
 * cannot drift onto different definitions of soon.
 */
export const EXPIRING_SOON_DAYS = 3;

/**
 * Inside the expiring-soon window, and not yet past.
 *
 * Deliberately excludes an expiry that has already passed: that is a different
 * state with a different colour, and a function that answered true for both
 * would make the caller re-check the thing it just asked about.
 *
 * A null boundary is open-ended, never soon.
 */
export function isExpiringSoon(boundary: DateString | null, today: Date): boolean {
  const days = remainingDays(boundary, today);

  return days !== null && days >= 0 && days <= EXPIRING_SOON_DAYS;
}

/**
 * `from` plus a whole number of CALENDAR months.
 *
 * Distinct from `addDays` and deliberately so. A renewal sold as "3 months"
 * means the same day of the month three months later — 20 October to 20
 * January — which is not any fixed number of days: those three months are 92
 * days, while the three after 20 February are 89. Expressing a month as 30 days
 * would move the date the customer was quoted.
 *
 * The day of the month is CLAMPED to the target month's length, because the
 * alternative is worse. 31 January plus one month has no 31 February to land
 * on; JavaScript's own `setUTCMonth` silently rolls it forward to 2 or 3 March,
 * which turns a one-month renewal into a one-month-and-two-days renewal and
 * depends on whether the year is a leap year. Clamping gives 28 or 29 February
 * — the last day of the month the customer bought — and never crosses into a
 * month they did not.
 *
 * UTC throughout, like everything else here.
 */
export function addMonths(from: Date, months: number): DateString {
  const day = from.getUTCDate();

  /* Anchored on the 1st so the month arithmetic cannot roll over on its own. */
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));

  /* Day 0 of the following month is the last day of the target month. */
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();

  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)))
    .toISOString()
    .slice(0, 10);
}

/**
 * `addMonths` in the shapes a `date` column deals in.
 *
 * The string-in, string-out form, mirroring `addDaysToDateString`: a renewal
 * extends from a stored `expiration_date` and writes one back, and routing that
 * through a Date at the call site is where a timezone bug gets in.
 *
 * Returns null when the input cannot be parsed, so a malformed value surfaces
 * as "no date" rather than as `Invalid Date` written to a date column.
 */
export function addMonthsToDateString(from: DateString | null, months: number): DateString | null {
  const parsed = parseDateString(from);

  return parsed === null ? null : addMonths(parsed, months);
}

/**
 * Whole days from `from` to `to`. Negative when `to` is earlier.
 *
 * `remainingDays` measured against a stored date rather than against the clock,
 * which is what a renewal needs twice: how many days it added, and how long the
 * subscription now runs from its sale date. Delegates rather than subtracting
 * again, so every day count in the application comes out of one function.
 *
 * Null when either side is absent or unparseable — "no interval", never zero.
 */
export function daysBetween(from: DateString | null, to: DateString | null): number | null {
  const start = parseDateString(from);

  return start === null ? null : remainingDays(to, start);
}
