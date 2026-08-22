import { formatPreparedProfile } from "@/lib/clipboard";
import { buildWhatsappUrl, normalizeIdentifier } from "@/lib/phone";

/**
 * WhatsApp click-to-chat links.
 *
 * Opens a conversation with the message already typed. It never sends anything:
 * wa.me hands the text to the composer and the operator presses Send. There is
 * no API call, no automation, and no code path here that could deliver a
 * message on its own.
 *
 * WHY THE LINK IS BUILT ON THE CLIENT, AT CLICK TIME
 *
 * The message carries the account password. A URL containing it must not exist
 * any earlier or anywhere wider than the screen already showing it: not in the
 * RSC payload, not in a server log, not in a database column, and not behind a
 * new endpoint. `PreparationResult` already carries the plaintext to this screen
 * because the transaction that produced it put it there, so composing the link
 * in the click handler adds no exposure that the page did not already have.
 *
 * Nothing here logs. The returned URL is handed straight to an anchor.
 *
 * ONE HELPER, BOTH FLOWS
 *
 * Quick Prepare and Quick Replace render the same `CredentialResult`, so they
 * get the same link from the same function. Quick Replace passes the result of
 * its own confirmation — the NEW account — because that is the only thing it
 * has: the replaced account is not in the result it renders.
 */

/** A profile as it appears in a finished preparation. */
export interface WhatsAppProfile {
  readonly profileNumber: number;
  readonly pin: string | null;
}

/** An account as it appears in a finished preparation. */
export interface WhatsAppAccount {
  readonly email: string;
  /** Plaintext, from the confirmed transaction. Never logged. */
  readonly password: string;
  readonly profiles: readonly WhatsAppProfile[];
}

export interface WhatsAppMessageInput {
  /**
   * The customer's stored identifier — the normalized form.
   *
   * A phone number is digits; a username is `@handle`. The distinction is what
   * decides whether a link is possible at all.
   */
  readonly identifier: string;
  readonly accounts: readonly WhatsAppAccount[];
  readonly durationDays: number;
  /** ISO `YYYY-MM-DD`, as the service returns it. */
  readonly expirationDate: string;
}

/**
 * Why a customer cannot be reached on WhatsApp.
 *
 * `username` is the ordinary case, not an error: the CRM deliberately accepts
 * handles as identifiers, and a handle is not a phone number. The screen says
 * so plainly and leaves the credentials copyable.
 */
export type WhatsAppUnavailableReason = "username" | "unusable_number";

export type WhatsAppLink =
  | { readonly available: true; readonly url: string; readonly message: string }
  | { readonly available: false; readonly reason: WhatsAppUnavailableReason };

/**
 * Formats the expiration for a customer, not for a database.
 *
 * `20 September 2026` rather than `2026-09-20`. Built in UTC on purpose: the
 * service returns a plain calendar date, and letting the browser's timezone
 * interpret it would show the previous day to anyone west of Greenwich.
 */
export function formatExpirationForCustomer(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);

  if (!year || !month || !day) {
    return isoDate;
  }

  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The message a customer receives.
 *
 * The credential block comes from `formatPreparedProfile`, the M13 §6 layout the
 * copy buttons already produce — so what is pasted by hand and what is sent
 * through WhatsApp are the same text, plus the two lines a customer needs that
 * a clipboard paste does not carry: how long it lasts and when it ends.
 *
 * Multiple profiles are separated by a rule, matching `formatPreparation`.
 */
export function buildWhatsAppMessage(input: WhatsAppMessageInput): string {
  const blocks = input.accounts.flatMap((account) =>
    account.profiles.map((profile) =>
      formatPreparedProfile({
        email: account.email,
        password: account.password,
        profileNumber: profile.profileNumber,
        pin: profile.pin,
      }),
    ),
  );

  const tail = [
    "Duration",
    `${input.durationDays} days`,
    "",
    "Expiration",
    formatExpirationForCustomer(input.expirationDate),
  ].join("\n");

  return [blocks.join("\n\n———\n\n"), tail].filter((part) => part !== "").join("\n\n");
}

/**
 * Builds the click-to-chat link, or explains why there cannot be one.
 *
 * Returns a discriminated union rather than an empty string. An empty `href`
 * renders a button that silently reloads the page — which is what a username
 * used to produce here — and a caller that must check `available` cannot make
 * that mistake by accident.
 */
export function buildWhatsAppLink(input: WhatsAppMessageInput): WhatsAppLink {
  const identifier = input.identifier.trim();

  if (identifier.startsWith("@")) {
    return { available: false, reason: "username" };
  }

  const destination = whatsappDestination(identifier);

  if (destination === null) {
    return { available: false, reason: "unusable_number" };
  }

  const message = buildWhatsAppMessage(input);

  return {
    available: true,
    message,
    url: `${destination}?text=${encodeURIComponent(message)}`,
  };
}

/**
 * The wa.me base URL for an identifier, or null when there cannot be one.
 *
 * Two kinds of value arrive here and they need different handling:
 *
 *   typed input    `0663947116`, `+97471601974` — normalisation understands it
 *   a stored key   `663947116`, `97471601974` — already normalised, no `+`
 *
 * Normalisation is tried first because it understands everything a person can
 * type, and a stored Algerian key round-trips through it unchanged.
 *
 * The fallback exists for exactly one case. `normalizeIdentifier` refuses a
 * bare international number without a `+` or `00` — deliberately, so a mistyped
 * local number is never silently read as foreign. A stored international key has
 * no `+`, so it lands in that refusal. Re-normalising the stored form was the
 * bug that told a Qatari customer "WhatsApp unavailable" on an allocation that
 * had succeeded, so a digit string too long to be a national number is read as
 * what it is: a key that already carries its own country code.
 */
function whatsappDestination(identifier: string): string | null {
  const parsed = normalizeIdentifier(identifier);

  if (parsed.ok) {
    if (parsed.value.kind === "username") {
      return null;
    }

    const url = buildWhatsappUrl(parsed.value.normalized);
    return url === "" ? null : url;
  }

  /* A stored international key: digits only, longer than any national number. */
  if (/^[1-9]\d{9,14}$/.test(identifier)) {
    return `https://wa.me/${identifier}`;
  }

  return null;
}
