import { PROFILE_STATE_LABELS } from "@/shared/ui/profile-state";
import type { AccountListRow } from "./accounts.service";
import { validityLabel } from "./account-presentation";
import { accountBadgeStyle } from "../components/status-badge";

/**
 * The accounts CSV.
 *
 * Pure: rows in, cells out. It computes nothing — every number and every label
 * arrives already decided by `listAccounts`, which is the same call the screen
 * makes. That is the whole point. An export that recomputed its own tallies
 * would drift from the table the moment either changed, and the operator would
 * have no way to tell which one was lying.
 *
 * The labels are borrowed rather than restated for the same reason:
 * `accountBadgeStyle` is the function that decides an account shows "Problem"
 * instead of "Healthy", `PROFILE_STATE_LABELS` is what the five indicator cells
 * read, and `validityLabel` is the Validity column. Spelling any of them out
 * again here would be a second opinion.
 */

/**
 * What may leave the server.
 *
 * This list is the security boundary for the export, and it is deliberately a
 * whitelist rather than an omission: `AccountListRow` already carries no
 * password, no PIN and no customer identity — `toAccountView` drops the
 * ciphertext before the row is built — but naming the columns means adding a
 * credential would take a deliberate edit here rather than happening by
 * accident when a field is added upstream.
 */
export const ACCOUNT_EXPORT_HEADERS = [
  "Email",
  "Status",
  "Health",
  "Country",
  "Created",
  "Profile 1",
  "Profile 2",
  "Profile 3",
  "Profile 4",
  "Profile 5",
  "Total profiles",
  "Available profiles",
  "Sold profiles",
  "Validity",
] as const;

/** Five cells, always, in profile order — a blank where a slot is missing. */
function profileCells(row: AccountListRow): string[] {
  return [1, 2, 3, 4, 5].map((number) => {
    const indicator = row.indicators.find((entry) => entry.profileNumber === number);

    return indicator ? PROFILE_STATE_LABELS[indicator.state] : "";
  });
}

/** An ISO date, which both Excel and Sheets read as a date without coercion. */
function isoDate(value: Date | string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? "" : (date.toISOString().slice(0, 10) ?? "");
}

export function accountToCsvRow(row: AccountListRow): readonly unknown[] {
  return [
    row.account.email,
    /* The badge's own rule, so an account with an open problem never exports "Healthy". */
    accountBadgeStyle(row.account.status, row.hasActiveProblem).label,
    row.account.healthScore,
    row.account.country ?? "",
    isoDate(row.account.createdAt),
    ...profileCells(row),
    row.account.profileSlots,
    row.availableProfiles,
    row.soldProfiles,
    validityLabel(row.remainingValidityDays, row.account.validUntil),
  ];
}
