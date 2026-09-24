import { addDaysToDateString, type DateString } from "@/lib/dates";

/**
 * Where a profile's expiration date comes from.
 *
 * Sale date plus duration is the source of truth; expiration is derived from
 * them and never entered. Keeping it as a third independent field is what let
 * the three drift apart — changing the duration left yesterday's expiration in
 * place, and the row then disagreed with itself in every screen that read it.
 *
 * Pure, and free of `server-only`, because both halves of the fix need it: the
 * edit form derives what it displays, and the service derives what it writes.
 * One function so the number on screen and the number in the column cannot
 * differ.
 *
 * The arithmetic itself is `addDaysToDateString`, which works in UTC and lets
 * the platform handle month rollover and leap days.
 */

/**
 * The expiration a profile should carry, or null when it cannot be derived.
 *
 * Null means "nothing to compute from", not "expires never" and not "expired".
 * A profile with a sale date but no duration is a real state in this data, and
 * the caller decides what to do with it — the service keeps whatever the row
 * already had rather than blanking a value the operator never touched.
 */
export function deriveExpirationDate(
  saleDate: DateString | null,
  durationDays: number | null,
): DateString | null {
  if (!saleDate || durationDays === null) {
    return null;
  }

  if (!Number.isInteger(durationDays) || durationDays <= 0) {
    return null;
  }

  return addDaysToDateString(saleDate, durationDays);
}

/**
 * The same rule, in the shapes an HTML form deals in.
 *
 * `<input type="date">` gives `YYYY-MM-DD` or an empty string, and
 * `<input type="number">` gives a string. Returning "" rather than null keeps
 * the read-only input controlled, so React does not switch it between
 * controlled and uncontrolled as the operator clears a field.
 */
export function deriveExpirationForInput(
  saleDate: string | undefined,
  durationDays: string | undefined,
): string {
  const days = Number(durationDays);

  if (!saleDate || !durationDays || Number.isNaN(days)) {
    return "";
  }

  return deriveExpirationDate(saleDate, days) ?? "";
}

/**
 * The expiration a row should be written with.
 *
 * Derives whenever both halves are present, and otherwise keeps what the row
 * already had. That fallback is the whole reason this is a named function
 * rather than a `??` buried in the service: "we could not derive it" and "it
 * expires never" look identical as null, and collapsing them would silently
 * blank a date on a profile whose duration was never recorded.
 */
export function resolveExpirationDate(
  saleDate: DateString | null,
  durationDays: number | null,
  fallback: DateString | null,
): DateString | null {
  return deriveExpirationDate(saleDate, durationDays) ?? fallback;
}

/**
 * The expiration the profile editor shows, as the server will compute it.
 *
 * The form sends a field only when the operator changed it, and a blank field
 * means "leave it alone" — so the server works from the submitted value where
 * there is one and the stored value otherwise, then calls
 * `resolveExpirationDate`. This does exactly that, with the same function, so
 * the date on screen before Save is the date the column holds after it.
 *
 * `deriveExpirationForInput` alone showed an empty box for a profile with a
 * stored expiration but no recorded duration, while the server kept that date.
 */
export function previewExpirationDate(
  form: { readonly saleDate?: string | undefined; readonly durationDays?: string | undefined },
  stored: {
    readonly saleDate: DateString | null;
    readonly durationDays: number | null;
    readonly expirationDate: DateString | null;
  },
): string {
  const saleDate = form.saleDate ? form.saleDate : stored.saleDate;
  const typed = form.durationDays ? Number(form.durationDays) : null;
  const durationDays = typed === null || Number.isNaN(typed) ? stored.durationDays : typed;

  return resolveExpirationDate(saleDate, durationDays, stored.expirationDate) ?? "";
}
