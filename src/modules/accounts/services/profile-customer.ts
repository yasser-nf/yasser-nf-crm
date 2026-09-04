import { formatPhoneForDisplay } from "@/lib/phone";
import { whatsappDestination } from "@/lib/whatsapp";
import type { CustomerRow } from "@/lib/drizzle/schema";

/**
 * Who holds a profile, resolved once for every screen that asks.
 *
 * The relationship is `profiles.customer_id` and nothing else. Not the phone on
 * the sale, not the account, not the profile number — a slot belongs to exactly
 * the customer its foreign key names, which is what lets one account carry five
 * different customers without any of them bleeding into a neighbour.
 *
 * The three cases are modelled as a union rather than a nullable customer
 * because "nobody holds this slot" and "somebody holds it but the record is
 * gone" are different facts, and a screen that collapses them into one blank
 * field is the bug this file exists to prevent.
 */

/** The minimum a screen needs to name a customer. Deliberately not CustomerRow. */
export interface ProfileCustomerSummary {
  readonly id: string;
  /**
   * What to print. A phone in the app's display format, or an `@username`.
   *
   * Built by `formatPhoneForDisplay` from `phone_normalized`, the same call the
   * customers table, the CSV export, Quick Prepare and Quick Replace all make.
   * `phone_original` is deliberately NOT used: numbers pasted from WhatsApp
   * carry invisible bidi control characters (U+202A/U+202C), which render as
   * stray marks and break copy-paste.
   */
  readonly label: string;
  /** Present only when someone typed one. Most customers have none. */
  readonly name: string | null;
  /**
   * A wa.me address, or null when there cannot be one.
   *
   * DERIVED, not the stored `customers.whatsapp_url` column — through the same
   * `whatsappDestination` that Quick Prepare and Quick Replace build their
   * links with, so one normalisation serves all three. Null for a username and
   * for a number wa.me cannot address; the card says "WhatsApp unavailable"
   * rather than offering a link that opens on nothing.
   */
  readonly whatsappUrl: string | null;
  /** Soft-deleted customers still own their past sales, but are marked. */
  readonly isArchived: boolean;
}

export type ProfileCustomerLink =
  /** `customer_id` is NULL. The slot is genuinely unheld. */
  | { readonly kind: "none" }
  /**
   * `customer_id` is set but no customer row came back.
   *
   * The schema makes this unreachable — the foreign key is ON DELETE SET NULL,
   * so deleting a customer frees the slot rather than orphaning it. Modelled
   * anyway: a restore from backup or a direct write could produce it, and the
   * page must say so rather than render an empty field or crash.
   */
  | { readonly kind: "unavailable"; readonly customerId: string }
  | { readonly kind: "linked"; readonly customer: ProfileCustomerSummary };

/**
 * Pairs a profile's `customer_id` with the row a LEFT JOIN returned for it.
 *
 * Both halves are required: the id alone cannot distinguish "unheld" from
 * "held by a missing record", and the joined row alone cannot either.
 */
export function resolveProfileCustomer(
  customerId: string | null,
  customer: CustomerRow | null,
): ProfileCustomerLink {
  if (customerId === null) {
    return { kind: "none" };
  }

  if (customer === null) {
    return { kind: "unavailable", customerId };
  }

  const name = customer.name?.trim();

  return {
    kind: "linked",
    customer: {
      id: customer.id,
      label: formatPhoneForDisplay(customer.phoneNormalized),
      name: name ? name : null,
      whatsappUrl: whatsappDestination(customer.phoneNormalized),
      isArchived: customer.deletedAt !== null,
    },
  };
}

/** The wording every screen uses, so none of them invents its own. */
export const PROFILE_CUSTOMER_EMPTY_LABEL = "No customer assigned";
export const PROFILE_CUSTOMER_MISSING_LABEL = "Customer unavailable";

/**
 * The single line to print for a link, whichever case it is.
 *
 * Returned as text rather than JSX so the CSV export, a copy action and the
 * cards can all agree without one of them re-deriving the wording.
 */
export function profileCustomerLabel(link: ProfileCustomerLink): string {
  switch (link.kind) {
    case "none":
      return PROFILE_CUSTOMER_EMPTY_LABEL;
    case "unavailable":
      return PROFILE_CUSTOMER_MISSING_LABEL;
    case "linked":
      return link.customer.label;
  }
}
