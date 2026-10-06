import type { SupplierRow } from "@/lib/drizzle/schema";

/**
 * Supplier status, derived rather than stored. M10 §4.
 *
 * `deactivated_at` is the only fact; "active" and "inactive" are read off it.
 * This follows `deriveCustomerStatus`, which reads `blocked_at` and
 * `deleted_at` the same way, and it follows ADR-013's rule: store what a person
 * decides, derive everything a second column would only restate.
 *
 * A stored status enum beside the timestamp would be two sources of truth for
 * one fact, free to disagree the moment either is written alone — and no CHECK
 * constraint can tie an enum to a timestamp's nullness.
 *
 * Pure. No clock: deactivation is not a function of time, unlike expiry. A
 * supplier deactivated in the future is not a state the application can create.
 */

export type SupplierStatus = "active" | "inactive";

export const SUPPLIER_STATUS_LABELS: Record<SupplierStatus, string> = {
  active: "Active",
  inactive: "Inactive",
};

export function deriveSupplierStatus(supplier: Pick<SupplierRow, "deactivatedAt">): SupplierStatus {
  return supplier.deactivatedAt === null ? "active" : "inactive";
}

/**
 * Whether a NEW account may be assigned to this supplier.
 *
 * M10 §23: an inactive supplier keeps the accounts it already owns, and no
 * further account may be pointed at it. Expressed as its own predicate rather
 * than an inline status check, because the service applies it in two places —
 * creating an account and changing one's supplier — and they must agree.
 */
export function acceptsNewAccounts(supplier: Pick<SupplierRow, "deactivatedAt">): boolean {
  return deriveSupplierStatus(supplier) === "active";
}
