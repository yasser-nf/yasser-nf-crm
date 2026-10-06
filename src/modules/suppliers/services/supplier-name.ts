/**
 * Supplier name identity. M10 §5.
 *
 * Pure, and free of `server-only`, because both halves of the rule need it: the
 * service writes `name_normalized` through `normalizeSupplierName`, and the
 * unique index on that column is what makes the rule a guarantee rather than a
 * check some future caller forgets.
 *
 * THE RULE
 *
 * Two names are the same supplier when they differ only in letter case or in
 * whitespace. "Supplier A", " supplier a " and "SUPPLIER  A" are one supplier.
 *
 * Modelled on `customers.phone_normalized`, the project's one existing
 * precedent for "the same identity typed two ways": store what was typed, store
 * the comparable form beside it, and let the database enforce uniqueness on the
 * second. Deriving it in a functional index instead would work, but it would
 * put the definition in SQL where the service could not reuse it, and the
 * service needs it to look a supplier up by name.
 */

/** A `name_normalized` value: lower-cased, with whitespace runs collapsed. */
export type NormalizedSupplierName = string;

/** Longest a supplier name may be. Generous for a business name; bounded. */
export const MAX_SUPPLIER_NAME_LENGTH = 120;

/** Longest a supplier note may be. Matches the account note bound. */
export const MAX_SUPPLIER_NOTES_LENGTH = 2000;

/**
 * The comparable form of a name.
 *
 * Three steps, in this order:
 *
 *   1. trim          — leading and trailing space is never part of a name
 *   2. collapse runs — "Supplier  A" and "Supplier A" are one supplier, and
 *                      double spaces are invisible on screen
 *   3. lower-case    — case is presentation, not identity
 *
 * Every kind of whitespace collapses, not just the space character:
 * `\\s` covers the tab and the non-breaking space that arrive when a name is
 * pasted out of a spreadsheet, which is exactly how these names will be
 * entered.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`: the result is a database key,
 * and a key whose value depends on the server's locale would differ between
 * machines. (Turkish dotless i is the classic case.)
 */
export function normalizeSupplierName(name: string): NormalizedSupplierName {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The name as it will be STORED and shown: trimmed, with runs collapsed, and
 * otherwise exactly as typed.
 *
 * Case is preserved deliberately. An operator who types "NetStore DZ" should
 * see "NetStore DZ", not "netstore dz" — the lower-cased form exists only to
 * compare with.
 */
export function cleanSupplierName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * Whether this is a usable supplier name.
 *
 * Rejects empty and whitespace-only input, and anything past the bound. The
 * Zod schema states the same rules with messages; this is the predicate behind
 * them, so the form, the service and a test all ask one function.
 */
export function isValidSupplierName(name: string): boolean {
  const cleaned = cleanSupplierName(name);

  return cleaned.length > 0 && cleaned.length <= MAX_SUPPLIER_NAME_LENGTH;
}

/** Whether two names denote the same supplier. */
export function isSameSupplierName(left: string, right: string): boolean {
  return normalizeSupplierName(left) === normalizeSupplierName(right);
}
