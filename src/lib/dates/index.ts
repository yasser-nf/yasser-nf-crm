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
 * Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative when `to` is earlier.
 *
 * The string-in form of the subtraction `remainingDays` performs against a
 * clock. M09A needs it to keep a renewed profile's `duration_days` honest:
 * expiration is derived from sale date plus duration (profile-dates.ts), so a
 * renewal that moves the expiry must restate the duration or the next edit of
 * that profile silently recomputes the old date back.
 *
 * Returns null when either side is absent or unparseable, so a missing date
 * surfaces as "cannot compute" rather than as a plausible wrong number.
 */
export function daysBetweenDateStrings(
  from: DateString | null,
  to: DateString | null,
): number | null {
  const start = parseDateString(from);
  const end = parseDateString(to);

  if (start === null || end === null) {
    return null;
  }

  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/** Days in a given UTC month. `month` is 0-based, as Date.UTC takes it. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * `from` plus a whole number of CALENDAR months, clamped to the month's end.
 *
 * A subscription sold as "one month" is a calendar month, not thirty days —
 * 31 January plus one month is 28 February, and a customer who renews on the
 * 31st does not expect a different answer from one who renews on the 1st.
 * `addDays` cannot express that, and multiplying months by 30 drifts five days
 * a year, which is why this is a separate function rather than a conversion.
 *
 * Month-end is CLAMPED, never rolled over. The naive form — setUTCMonth on a
 * date whose day does not exist in the target month — silently rolls into the
 * following month: 31 January plus one month becomes 3 March, which hands the
 * customer three free days and reads as a correct date in every screen. The
 * day is therefore clamped to the target month's length before the date is
 * built, so 31 Jan + 1 → 28 Feb, and in a leap year → 29 Feb.
 *
 * Clamping is not reversible, and deliberately so: 31 Jan + 1 month − 1 month
 * is 28 Feb, not 31 Jan. Renewals only ever move forward, and a renewal chain
 * is computed from the stored expiry each time rather than from the original
 * sale date, so the clamp applies at most once per renewal.
 */
export function addMonthsToDateString(from: DateString | null, months: number): DateString | null {
  const parsed = parseDateString(from);

  if (parsed === null || !Number.isInteger(months)) {
    return null;
  }

  const year = parsed.getUTCFullYear();
  const month = parsed.getUTCMonth();
  const day = parsed.getUTCDate();

  /* Normalised through Date.UTC so a month index beyond 11 rolls the year. */
  const target = new Date(Date.UTC(year, month + months, 1));
  const clampedDay = Math.min(day, daysInMonth(target.getUTCFullYear(), target.getUTCMonth()));

  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), clampedDay))
    .toISOString()
    .slice(0, 10);
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
