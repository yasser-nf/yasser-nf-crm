import {
  addDaysToDateString,
  addMonthsToDateString,
  daysBetweenDateStrings,
  isPast,
  todayAsDateString,
  type DateString,
} from "@/lib/dates";

/**
 * The renewal date rules (M09A). Pure: the caller supplies the clock.
 *
 * Two decisions live here, and both are business rules rather than arithmetic,
 * which is why they are named, documented and tested in isolation rather than
 * inlined into the service.
 */

/** The periods the operator may pick, plus a free-form day count. */
export const RENEWAL_MONTH_OPTIONS = [1, 2, 3, 6, 12] as const;
export type RenewalMonths = (typeof RENEWAL_MONTH_OPTIONS)[number];

/** Matches the `duration_days > 0` check on profiles, with a sane ceiling. */
export const MIN_RENEWAL_DAYS = 1;
export const MAX_RENEWAL_DAYS = 730;

export type RenewalDuration =
  | { readonly unit: "months"; readonly months: RenewalMonths }
  | { readonly unit: "days"; readonly days: number };

/**
 * Where the renewed period starts.
 *
 * `continues` — the subscription is still running, so the new period is added
 * to the existing expiry and the customer keeps every day already paid for.
 * The brief states this rule, and it is what the existing replacement flow
 * assumes when it carries an absolute expiry across accounts.
 *
 * `restarts` — the subscription had already lapsed. THE REPOSITORY STATES NO
 * RULE FOR THIS CASE (see docs: Quick Replace refuses an expired allocation
 * outright and sends the operator to Quick Prepare instead), so this is a
 * recommended rule, applied visibly rather than silently: the period runs from
 * today, and the lapsed days are not restored.
 *
 * Extending from a past expiry — the only alternative — can produce a new
 * expiry that is itself already in the past whenever the lapse is longer than
 * the renewal, which would record a renewal that gives the customer nothing.
 * That is why it is not the default. The preview names the rule on screen so
 * the operator sees which one was applied before confirming.
 */
export type RenewalBasis = "continues" | "restarts";

export interface RenewalBase {
  readonly basis: RenewalBasis;
  /** The date the renewed period is measured from. */
  readonly from: DateString;
}

/**
 * Which date the renewal extends from, given the current expiry and today.
 *
 * Returns null when there is no current expiry: a profile with no recorded
 * expiry has no period to extend, and inventing one here would write a
 * confident date onto a row whose history nobody knows. The service refuses
 * that case explicitly instead.
 */
export function renewalBase(currentExpiration: DateString | null, now: Date): RenewalBase | null {
  if (!currentExpiration) {
    return null;
  }

  if (isPast(currentExpiration, now)) {
    return { basis: "restarts", from: todayAsDateString(now) };
  }

  return { basis: "continues", from: currentExpiration };
}

/** The duration as a human phrase, for the preview and the recorded event. */
export function describeDuration(duration: RenewalDuration): string {
  if (duration.unit === "days") {
    return `${duration.days} day${duration.days === 1 ? "" : "s"}`;
  }

  return duration.months === 12
    ? "1 year"
    : `${duration.months} month${duration.months === 1 ? "" : "s"}`;
}

/** `from` plus the duration. Calendar months for months; whole days for days. */
export function applyDuration(from: DateString, duration: RenewalDuration): DateString | null {
  return duration.unit === "months"
    ? addMonthsToDateString(from, duration.months)
    : addDaysToDateString(from, duration.days);
}

export interface RenewalPlan {
  readonly basis: RenewalBasis;
  /** The date the new period is measured from. */
  readonly from: DateString;
  readonly currentExpiration: DateString;
  readonly newExpiration: DateString;
  /**
   * What `duration_days` must become so that sale date plus duration still
   * equals the expiry — the invariant `profile-dates.ts` derives from. Null
   * when the profile has no sale date, which the service refuses.
   */
  readonly durationDays: number | null;
  /** Days the customer gains, for the preview. */
  readonly daysAdded: number;
  readonly description: string;
}

/**
 * The whole renewal, computed once and used for both the preview and the write.
 *
 * One function so the date the operator approves is the date the column
 * receives — the same reason `previewExpirationDate` exists for the profile
 * editor. Returns null when the dates cannot be computed at all.
 */
export function planRenewal(input: {
  readonly saleDate: DateString | null;
  readonly currentExpiration: DateString | null;
  readonly duration: RenewalDuration;
  readonly now: Date;
}): RenewalPlan | null {
  const base = renewalBase(input.currentExpiration, input.now);

  if (!base || !input.currentExpiration) {
    return null;
  }

  const newExpiration = applyDuration(base.from, input.duration);

  if (!newExpiration) {
    return null;
  }

  const daysAdded = daysBetweenDateStrings(input.currentExpiration, newExpiration);

  return {
    basis: base.basis,
    from: base.from,
    currentExpiration: input.currentExpiration,
    newExpiration,
    durationDays: daysBetweenDateStrings(input.saleDate, newExpiration),
    daysAdded: daysAdded ?? 0,
    description: describeDuration(input.duration),
  };
}
