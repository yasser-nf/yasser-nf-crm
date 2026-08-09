import type { CustomerRow } from "@/lib/drizzle/schema";

/**
 * Customer status and expiry, derived rather than stored.
 *
 * Pure functions with an injected `today`, so they are testable without mocking
 * a clock and produce the same answer for the same inputs.
 *
 * M05 asks for status to be computed wherever possible. Three of the four are:
 * only Blocked is a human decision with nothing to infer it from.
 */

export type CustomerStatus = "active" | "inactive" | "blocked" | "archived";

/** A live allocation the customer currently holds. */
export interface SubscriptionSummary {
  readonly expirationDate: string | null;
  readonly status: string;
}

/**
 * Whole days until expiry. Negative once past.
 *
 * Both dates are reduced to UTC midnight before subtracting. Comparing raw
 * timestamps would make "expires today" flip at an arbitrary time of day
 * depending on when the sale happened.
 */
export function remainingDays(expirationDate: string | null, today: Date): number | null {
  if (!expirationDate) {
    return null;
  }

  const expiry = Date.parse(`${expirationDate}T00:00:00Z`);

  if (Number.isNaN(expiry)) {
    return null;
  }

  const midnightToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  return Math.round((expiry - midnightToday) / 86_400_000);
}

export type ExpiryUrgency = "expired" | "today" | "tomorrow" | "soon" | "later" | "none";

/**
 * How urgently an allocation needs attention.
 *
 * "soon" is three days, matching the highlight M05 specifies.
 */
export function expiryUrgency(expirationDate: string | null, today: Date): ExpiryUrgency {
  const days = remainingDays(expirationDate, today);

  if (days === null) {
    return "none";
  }

  if (days < 0) return "expired";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 3) return "soon";
  return "later";
}

/** True when the allocation is still serving the customer. */
export function isSubscriptionActive(subscription: SubscriptionSummary, today: Date): boolean {
  if (subscription.status !== "sold" && subscription.status !== "expiring_soon") {
    return false;
  }

  const days = remainingDays(subscription.expirationDate, today);

  /* No expiry recorded means open-ended rather than expired. */
  return days === null || days >= 0;
}

/**
 * Derives customer status.
 *
 * Order is deliberate and is itself the business rule: archived outranks
 * blocked, and blocked outranks whatever their subscriptions say. A blocked
 * customer holding a live profile is still blocked — showing them as Active
 * would invite a worker to serve someone who was deliberately stopped.
 */
export function deriveCustomerStatus(
  customer: Pick<CustomerRow, "blockedAt" | "deletedAt">,
  subscriptions: readonly SubscriptionSummary[],
  today: Date,
): CustomerStatus {
  if (customer.deletedAt !== null) {
    return "archived";
  }

  if (customer.blockedAt !== null) {
    return "blocked";
  }

  return subscriptions.some((subscription) => isSubscriptionActive(subscription, today))
    ? "active"
    : "inactive";
}

export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  blocked: "Blocked",
  archived: "Archived",
};
