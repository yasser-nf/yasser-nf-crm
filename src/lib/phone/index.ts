import { ValidationError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";

/**
 * Phone Engine.
 *
 * 02_ARCHITECTURE.md: "No feature should normalize phone numbers itself." This
 * module is the only place that knows how an Algerian number is written.
 *
 * 01_MASTER_RULES.md makes the normalized number the customer's identity, so a
 * bug here does not merely display a number wrongly — it merges two customers or
 * splits one in two.
 *
 * Every accepted form reduces to the same nine digits:
 *
 *   +213 663 94 71 16   →  663947116
 *   00213663947116      →  663947116
 *   0663947116          →  663947116
 *   663947116           →  663947116
 *
 * Client-safe by design: the login form, the Quick Prepare popup and any future
 * import all need it, so it imports nothing server-only.
 */

export const ALGERIA_COUNTRY_CODE = "213";

/**
 * A national number is nine digits and never starts with zero.
 *
 * Algerian mobiles begin 5, 6 or 7; landlines use other leading digits. The
 * check is deliberately looser than "mobile only" — 03_DATABASE.md's constraint
 * accepts 6 to 20 digits, and rejecting a valid landline would block a real
 * customer for no benefit.
 */
const NATIONAL_NUMBER_LENGTH = 9;

/** Everything that is not a digit or a leading plus is noise. */
function stripFormatting(input: string): string {
  return input.replace(/[^\d+]/g, "");
}

/**
 * Reduces any accepted Algerian form to its nine national digits.
 *
 * Order matters. `00213` must be tested before `0`, or the international prefix
 * would be mistaken for a national trunk prefix and leave `213663947116`.
 */
function toNationalDigits(cleaned: string): string | null {
  let digits = cleaned;

  if (digits.startsWith("+")) {
    digits = digits.slice(1);
  }

  if (digits.startsWith(`00${ALGERIA_COUNTRY_CODE}`)) {
    digits = digits.slice(2 + ALGERIA_COUNTRY_CODE.length);
  } else if (digits.startsWith(ALGERIA_COUNTRY_CODE) && digits.length > NATIONAL_NUMBER_LENGTH) {
    /*
     * The length guard prevents a nine-digit national number that happens to
     * begin 213 from having its own first three digits removed.
     */
    digits = digits.slice(ALGERIA_COUNTRY_CODE.length);
  } else if (digits.startsWith("00")) {
    /* An international call to somewhere other than Algeria. */
    return null;
  }

  /* National trunk prefix, as dialled inside the country. */
  if (digits.length === NATIONAL_NUMBER_LENGTH + 1 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  if (digits.length !== NATIONAL_NUMBER_LENGTH || !/^[1-9]\d{8}$/.test(digits)) {
    return null;
  }

  return digits;
}

export interface NormalizedPhone {
  /** Exactly as the operator typed it. Shown back to them. */
  readonly original: string;
  /** Nine digits. The customer identity key. */
  readonly normalized: string;
  /** Full international form, for display. */
  readonly international: string;
  /** Click-to-chat link. */
  readonly whatsappUrl: string;
}

/**
 * Normalizes a phone number.
 *
 * Returns a Result rather than throwing: a mistyped number is the most ordinary
 * thing that happens on this form, not an exception.
 */
export function normalizePhone(input: string): Result<NormalizedPhone> {
  const original = input.trim();

  if (original.length === 0) {
    return fail(
      new ValidationError("Phone number is empty", {
        userMessage: "Enter a phone number.",
        fieldErrors: { phone: "Phone number is required" },
      }),
    );
  }

  const national = toNationalDigits(stripFormatting(original));

  if (national === null) {
    return fail(
      new ValidationError(`Unrecognised Algerian phone format: ${original}`, {
        userMessage: "That does not look like an Algerian phone number.",
        fieldErrors: {
          phone: "Use 0663947116, 663947116, +213663947116 or 00213663947116",
        },
      }),
    );
  }

  return ok({
    original,
    normalized: national,
    international: `+${ALGERIA_COUNTRY_CODE}${national}`,
    whatsappUrl: buildWhatsappUrl(national),
  });
}

/**
 * Builds the click-to-chat URL.
 *
 * wa.me requires the full international number with no plus and no separators.
 */
export function buildWhatsappUrl(normalized: string): string {
  return `https://wa.me/${ALGERIA_COUNTRY_CODE}${normalized}`;
}

/**
 * Formats a normalized number for display.
 *
 * 663947116 → 0663 94 71 16, which is how it is written locally.
 */
export function formatPhoneForDisplay(normalized: string): string {
  if (normalized.length !== NATIONAL_NUMBER_LENGTH) {
    return normalized;
  }

  const groups = [
    `0${normalized.slice(0, 3)}`,
    normalized.slice(3, 5),
    normalized.slice(5, 7),
    normalized.slice(7, 9),
  ];

  return groups.join(" ");
}

/** True when the input reduces to a valid Algerian number. */
export function isValidAlgerianPhone(input: string): boolean {
  return normalizePhone(input).ok;
}
