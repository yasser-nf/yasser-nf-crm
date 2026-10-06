import {
  addDaysToDateString,
  addMonthsToDateString,
  daysBetween,
  remainingDays,
  todayAsDateString,
  type DateString,
} from "@/lib/dates";

/**
 * What a renewal does to a subscription's dates. M09 §8 and §9.
 *
 * Pure, clock-injected, and free of `server-only` and of any module barrel —
 * deliberately, and for the same reason `profile-dates.ts` is: both halves of
 * the flow need it. The screen derives the expiry it SHOWS and the service
 * derives the expiry it WRITES, from this one function, so the date an operator
 * quotes a customer and the date the column holds cannot differ.
 *
 * THE RULE THIS FILE EXISTS FOR
 *
 * A renewal of a LIVE subscription extends from its current expiry, never from
 * today. 20 October plus three months is 20 January, whether the operator
 * renews on the 1st or the 19th — a customer who renews early must not lose the
 * days they already paid for, which is exactly what restarting the clock would
 * do.
 *
 * A renewal of a LAPSED subscription starts today. That is not a new rule
 * either: 03_DATABASE.md's "Expired Profile → Automatically Available if
 * account is Healthy" makes a lapsed allocation free stock again (derived from
 * the date, ADR-013 D2), and Quick Replace already refuses one with "prepare a
 * new subscription instead" because there is nothing left to carry over.
 * Selling that slot again is a sale, and a sale starts the day it is made.
 * Extending from a date in the past would hand the customer a subscription that
 * is already partly spent.
 */

/** A renewal length offered as one tap. M09 §8. */
export interface RenewalPreset {
  readonly id: RenewalPresetId;
  /** Calendar months, never a day count. See `addMonths`. */
  readonly months: number;
  readonly label: string;
}

export type RenewalPresetId = "1_month" | "2_months" | "3_months" | "6_months" | "1_year";

/**
 * The five presets, in the order M09 §8 lists them.
 *
 * Expressed in MONTHS rather than days. "3 months" is what is sold and what the
 * customer is told; 90 days is a different promise that happens to be close,
 * and which of the two an operator meant is not recoverable afterwards.
 */
export const RENEWAL_PRESETS: readonly RenewalPreset[] = [
  { id: "1_month", months: 1, label: "1 month" },
  { id: "2_months", months: 2, label: "2 months" },
  { id: "3_months", months: 3, label: "3 months" },
  { id: "6_months", months: 6, label: "6 months" },
  { id: "1_year", months: 12, label: "1 year" },
];

/** What the operator chose: one of the presets, or their own number of days. */
export type RenewalDuration =
  | { readonly kind: "preset"; readonly preset: RenewalPresetId }
  | { readonly kind: "custom"; readonly days: number };

/**
 * Where the renewal counts from.
 *
 *   current_expiry  the subscription is still running; its expiry moves out
 *   today           it had lapsed, so this is a fresh term
 */
export type RenewalBasis = "current_expiry" | "today";

/** Everything a renewal changes, computed once. */
export interface RenewalQuote {
  readonly basis: RenewalBasis;
  /** The date the renewal counts from. */
  readonly baseDate: DateString;
  /** What the profile expires on today. Null when it carries no expiry at all. */
  readonly previousExpirationDate: DateString | null;
  /** What it will expire on. */
  readonly expirationDate: DateString;
  /** Whole days the renewal adds. Always positive. */
  readonly addedDays: number;
  /**
   * The sale date the row should carry afterwards.
   *
   * Unchanged by an extension — that is when this subscription began, and it is
   * history. Set to today for a fresh term, because the term starts now.
   */
  readonly saleDate: DateString;
  /**
   * `duration_days` the row should carry afterwards: the whole span from
   * `saleDate` to `expirationDate`.
   *
   * Not the renewal length. `profile-dates.ts` makes expiration = sale date +
   * duration the source of truth for a profile's dates, and the profile editor
   * re-derives the expiry from those two on every save. Writing the renewal
   * length here would leave a row that disagrees with itself and whose expiry
   * the next unrelated edit would silently undo.
   */
  readonly durationDays: number;
  /** How the renewal reads on screen, in a receipt, and in history. */
  readonly label: string;
  readonly preset: RenewalPresetId | null;
  readonly customDays: number | null;
}

export function presetById(id: string): RenewalPreset | null {
  return RENEWAL_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** How a chosen duration reads. One wording for the screen, the audit and history. */
export function renewalLabel(duration: RenewalDuration): string {
  if (duration.kind === "custom") {
    return `${duration.days} day${duration.days === 1 ? "" : "s"}`;
  }

  return presetById(duration.preset)?.label ?? duration.preset;
}

/**
 * Whether this subscription is still running, and so extends rather than restarts.
 *
 * Measured from `expiration_date` against the clock, never from
 * `profiles.status`: nothing in this codebase writes `expired`, so a status
 * check would call every lapsed allocation live (ADR-013 D2). Expiring TODAY is
 * still running — the customer has the day they paid for.
 *
 * A profile with no expiry at all has no boundary to extend, so it restarts.
 */
export function renewalBasis(expirationDate: DateString | null, today: Date): RenewalBasis {
  const days = remainingDays(expirationDate, today);

  return days !== null && days >= 0 ? "current_expiry" : "today";
}

/**
 * What a renewal would do, or null when it would do nothing coherent.
 *
 * Null is returned rather than a thrown error or a zero-day quote: the caller
 * is either a form deriving what to display or a service deciding what to
 * write, and both need to say "that is not a renewal" rather than show or
 * commit a date they cannot explain. The input schema rejects a bad duration
 * long before here; this is the second layer, so a quote is never a guess.
 */
export function quoteRenewal(
  current: {
    readonly saleDate: DateString | null;
    readonly expirationDate: DateString | null;
  },
  duration: RenewalDuration,
  today: Date,
): RenewalQuote | null {
  if (duration.kind === "custom" && (!Number.isInteger(duration.days) || duration.days < 1)) {
    return null;
  }

  const todayString = todayAsDateString(today);
  const basis = renewalBasis(current.expirationDate, today);

  /*
   * `current_expiry` guarantees a non-null expiry — that is what it means — so
   * the fallback is unreachable rather than a default. Written as a coalesce
   * because narrowing a readonly field through a separate predicate is not
   * something TypeScript can follow, and an assertion here would be the kind of
   * "trust me" this codebase has been bitten by.
   */
  const baseDate =
    basis === "current_expiry" ? (current.expirationDate ?? todayString) : todayString;

  const expirationDate =
    duration.kind === "preset"
      ? addMonthsToDateString(baseDate, presetById(duration.preset)?.months ?? 0)
      : addDaysToDateString(baseDate, duration.days);

  if (expirationDate === null) {
    return null;
  }

  const addedDays = daysBetween(baseDate, expirationDate);

  if (addedDays === null || addedDays <= 0) {
    return null;
  }

  /*
   * An extension keeps the original sale date, which is the one thing on the
   * row that says when this customer's subscription began. The fallback covers
   * a live allocation with no recorded sale date — rare, and real in data that
   * predates Quick Prepare — where there is no original to keep.
   */
  const saleDate = basis === "current_expiry" ? (current.saleDate ?? todayString) : todayString;
  const durationDays = daysBetween(saleDate, expirationDate);

  if (durationDays === null || durationDays <= 0) {
    return null;
  }

  return {
    basis,
    baseDate,
    previousExpirationDate: current.expirationDate,
    expirationDate,
    addedDays,
    saleDate,
    durationDays,
    label: renewalLabel(duration),
    preset: duration.kind === "preset" ? duration.preset : null,
    customDays: duration.kind === "custom" ? duration.days : null,
  };
}
