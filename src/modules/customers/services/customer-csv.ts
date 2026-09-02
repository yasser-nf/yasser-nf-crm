import { formatPhoneForDisplay } from "@/lib/phone";
import type { CustomerWithStats } from "../repositories/customers.repository";
import { CUSTOMER_STATUS_LABELS, statusFromTallies } from "./customer-status";

/**
 * The customers CSV.
 *
 * Pure: rows in, cells out. The tallies arrive already aggregated by
 * `listWithStats` — the same query the customers screen runs — and the status
 * comes from `statusFromTallies`, which is the function the table's badge uses.
 * Nothing is recounted here, so the file cannot disagree with the screen.
 */

/**
 * What may leave the server.
 *
 * A whitelist, not an omission. `CustomerWithStats` carries the whole customer
 * row, which includes internal ids and timestamps nobody outside the CRM needs;
 * naming the columns keeps the file to what an operator actually works with and
 * makes widening it a deliberate edit.
 *
 * No profile PINs, no Netflix credentials, and no per-profile detail: those
 * belong to accounts, and a customer export is not a way to reach them.
 */
export const CUSTOMER_EXPORT_HEADERS = [
  "Identifier",
  "Last purchase",
  "Created",
  "Status",
  "Active profiles",
  "Expired profiles",
  "Notes",
] as const;

/**
 * ISO, not the locale format the table shows.
 *
 * The only deliberate difference between screen and file. A spreadsheet sorts
 * and filters an ISO date correctly in every locale, where "2 sept. 2026" is a
 * string that sorts alphabetically and imports differently on every machine.
 * The value is identical; only the rendering differs.
 */
function isoDate(value: Date | string | null): string {
  if (value === null) {
    return "";
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? "" : (date.toISOString().slice(0, 10) ?? "");
}

export function customerToCsvRow(row: CustomerWithStats, today = new Date()): readonly unknown[] {
  return [
    /* The same formatting the table shows: +2126…, @handle, or 0512 34 56 78. */
    formatPhoneForDisplay(row.customer.phoneNormalized),
    isoDate(row.customer.lastPurchaseAt),
    isoDate(row.customer.createdAt),
    CUSTOMER_STATUS_LABELS[statusFromTallies(row.customer, row.activeProfiles, today)],
    row.activeProfiles,
    row.expiredProfiles,
    /* Free text, and the reason the CSV escaping has to be right. */
    row.customer.notes ?? "",
  ];
}
