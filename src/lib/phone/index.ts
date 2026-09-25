import { ValidationError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";

/**
 * Customer Identifier Engine.
 *
 * 02_ARCHITECTURE.md: "No feature should normalize phone numbers itself." This
 * module is the only place that knows how a customer is identified.
 *
 * 01_MASTER_RULES.md makes the normalized value the customer's identity, so a
 * bug here does not merely display a value wrongly — it merges two customers or
 * splits one in two.
 *
 * A customer is reached in one of two ways, and the field accepts both:
 *
 *   phone      +213 663 94 71 16, 0663947116, +97471601974, +33123456789
 *   username   @RAHIMOU, @yasser123
 *
 * ALGERIAN NUMBERS KEEP THEIR EXISTING IDENTITY
 *
 * Algerian numbers still reduce to nine national digits, exactly as before:
 *
 *   +213 663 94 71 16   →  663947116
 *   00213663947116      →  663947116
 *   0663947116          →  663947116
 *   663947116           →  663947116
 *
 * That is not a stylistic choice. Every existing customer row is keyed on those
 * nine digits, so normalizing Algeria to a full international key would orphan
 * the entire existing customer base.
 *
 * Numbers from anywhere else key on their full international digits — country
 * code included, no plus — because there is no national context to strip them
 * against:
 *
 *   +974 7160 1974      →  97471601974
 *   +33 1 23 45 67 89   →  33123456789
 *
 * Usernames key on their lower-cased form, so @RAHIMOU and @rahimou are one
 * customer rather than two. The original spelling is preserved separately.
 *
 * Client-safe by design: the login form, the Quick Prepare popup and any future
 * import all need it, so it imports nothing server-only.
 */

export const ALGERIA_COUNTRY_CODE = "213";

/** An Algerian national number is nine digits and never starts with zero. */
const NATIONAL_NUMBER_LENGTH = 9;

/**
 * E.164 allows at most fifteen digits including the country code, and no
 * assignable number is shorter than eight. Anything outside that is a typo
 * rather than a country this business has not met yet.
 */
const MIN_INTERNATIONAL_DIGITS = 8;
const MAX_INTERNATIONAL_DIGITS = 15;

/**
 * Usernames are the handle a customer is known by on a messaging app.
 *
 * Letters, digits, underscore and dot — the intersection of what the common
 * platforms allow. Deliberately not permitting spaces or `@` inside the name,
 * so the leading `@` stays an unambiguous marker of "this is not a number".
 */
const USERNAME_BODY = /^[A-Za-z0-9_.]{1,30}$/;

export type IdentifierKind = "phone" | "username";

export interface NormalizedIdentifier {
  /** Which of the two forms this is. */
  readonly kind: IdentifierKind;
  /** Exactly as the operator typed it. Shown back to them. */
  readonly original: string;
  /** The customer identity key, and the only unique column. */
  readonly normalized: string;
  /** Full international form for a phone, `@name` for a username. */
  readonly international: string;
  /**
   * Click-to-chat link, or empty when there is none.
   *
   * A username has no wa.me address — wa.me addresses a number. Empty string
   * rather than null because the column is NOT NULL and every existing row has
   * one; callers rendering a link must check for empty.
   */
  readonly whatsappUrl: string;
}

/** Everything that is not a digit or a leading plus is noise. */
function stripFormatting(input: string): string {
  return input.replace(/[^\d+]/g, "");
}

/**
 * Reduces any accepted Algerian form to its nine national digits.
 *
 * Order matters. `00213` must be tested before `0`, or the international prefix
 * would be mistaken for a national trunk prefix and leave `213663947116`.
 *
 * Returns null when the input is not Algerian — which is now a routing signal
 * rather than a rejection, because the caller then tries the international path.
 */
function toAlgerianNationalDigits(cleaned: string): string | null {
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

/**
 * Reduces an explicitly international number to its full digits.
 *
 * Only reached when the operator wrote `+` or `00`, because without one of
 * those there is no way to tell a foreign number from a mistyped local one.
 */
function toInternationalDigits(cleaned: string): string | null {
  let digits: string;

  if (cleaned.startsWith("+")) {
    digits = cleaned.slice(1);
  } else if (cleaned.startsWith("00")) {
    digits = cleaned.slice(2);
  } else {
    return null;
  }

  if (!/^[1-9]\d*$/.test(digits)) {
    return null;
  }

  if (digits.length < MIN_INTERNATIONAL_DIGITS || digits.length > MAX_INTERNATIONAL_DIGITS) {
    return null;
  }

  return digits;
}

function invalidIdentifier(original: string): ValidationError {
  return new ValidationError(`Unrecognised customer identifier: ${original}`, {
    userMessage: "Enter a valid phone number or username.",
    fieldErrors: {
      phone: "Enter a phone number with country code, or a username such as @username",
    },
  });
}

/**
 * Normalizes a customer identifier — phone number or username.
 *
 * Returns a Result rather than throwing: a mistyped identifier is the most
 * ordinary thing that happens on this form, not an exception.
 */
export function normalizeIdentifier(input: string): Result<NormalizedIdentifier> {
  const original = input.trim();

  if (original.length === 0) {
    return fail(
      new ValidationError("Customer identifier is empty", {
        userMessage: "Enter a phone number or username.",
        fieldErrors: { phone: "Phone number or username is required" },
      }),
    );
  }

  /*
   * The leading `@` decides. Checked before any digit handling so a username is
   * never run through phone validation, which would reject every one of them.
   */
  if (original.startsWith("@")) {
    const body = original.slice(1);

    if (!USERNAME_BODY.test(body)) {
      return fail(invalidIdentifier(original));
    }

    const handle = `@${body.toLowerCase()}`;

    return ok({
      kind: "username",
      original,
      normalized: handle,
      international: handle,
      whatsappUrl: "",
    });
  }

  const cleaned = stripFormatting(original);

  /* Algeria first: it is the only country with a national short form here. */
  const algerian = toAlgerianNationalDigits(cleaned);

  if (algerian !== null) {
    return ok({
      kind: "phone",
      original,
      normalized: algerian,
      international: `+${ALGERIA_COUNTRY_CODE}${algerian}`,
      whatsappUrl: buildWhatsappUrl(algerian),
    });
  }

  const international = toInternationalDigits(cleaned);

  if (international !== null) {
    return ok({
      kind: "phone",
      original,
      normalized: international,
      international: `+${international}`,
      whatsappUrl: `https://wa.me/${international}`,
    });
  }

  return fail(invalidIdentifier(original));
}

/** Fewer digits than this match too much of the customer base to mean anything. */
export const MIN_SEARCH_DIGITS = 3;

/** Digits, a leading plus, and the separators people type between digit groups. */
const PHONE_SHAPED = /^\+?[\d\s().\-/]+$/;

/**
 * What to look for in `phone_normalized` when someone types PART of an
 * identifier into a search box.
 *
 * `normalizeIdentifier` only accepts a whole number, but people search with
 * fragments — "0663 94", "+213 663", "@rah". A fragment cannot be normalized,
 * yet the stored key is always the normalized form, so the prefixes the engine
 * strips from a whole number are stripped from the fragment the same way:
 *
 *   0663 94      →  066394, 66394       national trunk 0 dropped
 *   +213 663 94  →  21366394, 66394     Algeria keeps national digits only
 *   00213 663    →  00213663, 663
 *   00974 7160   →  009747160, 9747160  other countries key without 00 / +
 *   663947116    →  663947116           a whole number: its exact key
 *   @RAH         →  @rah                handles are stored lower-cased
 *
 * Every result is a SUBSTRING to look for, never an identity: this is for
 * finding customers, not for deciding who a customer is.
 *
 * Only input that is shaped like a phone number — digits and the characters
 * people write between them — yields keys. Digits inside other text are not a
 * phone: "user123@icloud.com" or "kids 2024" must not list every customer whose
 * number happens to contain 123 or 2024.
 */
export function identifierSearchKeys(input: string): string[] {
  const original = input.trim();

  if (original.startsWith("@")) {
    return original.length > 1 ? [original.toLowerCase()] : [];
  }

  if (!PHONE_SHAPED.test(original)) {
    return [];
  }

  const cleaned = stripFormatting(original);
  const hadPlus = cleaned.startsWith("+");
  const digits = cleaned.replace(/\D/g, "");

  if (digits.length < MIN_SEARCH_DIGITS) {
    return [];
  }

  const keys = new Set<string>([digits]);
  const whole = normalizeIdentifier(original);

  if (whole.ok) {
    keys.add(whole.value.normalized);
  }

  if (digits.startsWith(`00${ALGERIA_COUNTRY_CODE}`)) {
    keys.add(digits.slice(2 + ALGERIA_COUNTRY_CODE.length));
  } else if (hadPlus && digits.startsWith(ALGERIA_COUNTRY_CODE)) {
    keys.add(digits.slice(ALGERIA_COUNTRY_CODE.length));
  } else if (digits.startsWith("00")) {
    keys.add(digits.slice(2));
  } else if (digits.startsWith("0")) {
    keys.add(digits.slice(1));
  }

  return [...keys].filter((key) => key.length >= MIN_SEARCH_DIGITS);
}

/**
 * Builds the click-to-chat URL for an Algerian national number.
 *
 * wa.me requires the full international number with no plus and no separators.
 * A key that already carries its country code is a full address on its own.
 */
export function buildWhatsappUrl(normalized: string): string {
  if (normalized.startsWith("@")) {
    return "";
  }

  if (normalized.length === NATIONAL_NUMBER_LENGTH) {
    return `https://wa.me/${ALGERIA_COUNTRY_CODE}${normalized}`;
  }

  return `https://wa.me/${normalized}`;
}

/**
 * Formats a normalized identifier for display.
 *
 * 663947116 → 0663 94 71 16, which is how it is written locally. Anything else
 * is shown in the form it is stored in, because grouping rules differ by country
 * and a wrong guess reads worse than no grouping at all.
 */
export function formatPhoneForDisplay(normalized: string): string {
  if (normalized.startsWith("@")) {
    return normalized;
  }

  if (normalized.length !== NATIONAL_NUMBER_LENGTH) {
    return /^\d{10,15}$/.test(normalized) ? `+${normalized}` : normalized;
  }

  const groups = [
    `0${normalized.slice(0, 3)}`,
    normalized.slice(3, 5),
    normalized.slice(5, 7),
    normalized.slice(7, 9),
  ];

  return groups.join(" ");
}

/** True when the input is a usable customer identifier. */
export function isValidCustomerIdentifier(input: string): boolean {
  return normalizeIdentifier(input).ok;
}
