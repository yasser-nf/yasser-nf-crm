import { remainingDays } from "@/lib/dates";
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
 * Re-exported from lib/dates rather than implemented here.
 *
 * This file carried its own byte-identical copy until M13 Phase B, and ADR-013
 * Decision 7 claimed the copy had been removed when it had not. Two identical
 * implementations are not harmless: M13 compares a customer's remaining days
 * against an account's remaining days, and if the two ever diverged the result
 * would be an off-by-one that sells a subscription the account cannot cover —
 * on exactly one day, in the boundary case.
 *
 * The name is kept so no caller changed.
 */
export { remainingDays };

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
