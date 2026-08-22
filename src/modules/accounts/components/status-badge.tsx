import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";
import { cn } from "@/utils/cn";

/**
 * Status badges.
 *
 * 04_UI_GUIDELINES.md assigns the colours explicitly:
 *
 *   Healthy   Green    Problem   Red      Expiring  Orange   Archived  Gray
 *   Available Green    Reserved  Blue     Sold      Purple   Expired   Red
 *
 * Both maps are exhaustive by type. Adding a value to either enum without a
 * colour here becomes a compile error rather than a badge that silently renders
 * unstyled.
 */

const BADGE_BASE =
  "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-caption font-medium whitespace-nowrap";

interface BadgeStyle {
  readonly label: string;
  readonly className: string;
  readonly dot: string;
}

const ACCOUNT_STATUS_STYLES: Record<AccountRow["status"], BadgeStyle> = {
  healthy: {
    label: "Healthy",
    className: "bg-success-subtle text-success",
    dot: "bg-success",
  },
  payment_problem: {
    label: "Payment Problem",
    className: "bg-danger-subtle text-danger",
    dot: "bg-danger",
  },
  incorrect_password: {
    label: "Incorrect Password",
    className: "bg-danger-subtle text-danger",
    dot: "bg-danger",
  },
  invalid_email: {
    label: "Invalid Email",
    className: "bg-danger-subtle text-danger",
    dot: "bg-danger",
  },
  something_went_wrong: {
    label: "Something Went Wrong",
    className: "bg-danger-subtle text-danger",
    dot: "bg-danger",
  },
  archived: {
    label: "Archived",
    className: "bg-neutral-subtle text-foreground-muted",
    dot: "bg-neutral",
  },
  deleted: {
    label: "Deleted",
    className: "bg-neutral-subtle text-foreground-subtle",
    dot: "bg-neutral",
  },
};

const PROFILE_STATUS_STYLES: Record<ProfileRow["status"], BadgeStyle> = {
  available: {
    label: "Available",
    className: "bg-success-subtle text-success",
    dot: "bg-success",
  },
  reserved: {
    label: "Reserved",
    className: "bg-info-subtle text-info",
    dot: "bg-info",
  },
  sold: {
    label: "Sold",
    className: "bg-accent-purple-subtle text-accent-purple",
    dot: "bg-accent-purple",
  },
  expiring_soon: {
    label: "Expiring Soon",
    className: "bg-warning-subtle text-warning",
    dot: "bg-warning",
  },
  expired: {
    label: "Expired",
    className: "bg-danger-subtle text-danger",
    dot: "bg-danger",
  },
};

/**
 * The "Not for sale" badge.
 *
 * Deliberately NOT a `profile_status` value — sellability is derived from
 * `profile_number <= accounts.profile_slots`, so it has no column to key off.
 * The caller decides when to render this instead of the status badge, using
 * `evaluateAllocation`'s `profile_not_for_sale` reason.
 *
 * The quietest style on the scale, on purpose: this is not a warning and not an
 * error, it is simply not stock. Alarm colours would train a worker to ignore
 * them on the profiles that genuinely need attention.
 */
export const NOT_FOR_SALE_STYLE: BadgeStyle = {
  label: "Not for sale",
  className: "bg-neutral-subtle text-foreground-subtle",
  dot: "bg-neutral",
};

function Badge({ style, className }: { style: BadgeStyle; className?: string }) {
  return (
    <span className={cn(BADGE_BASE, style.className, className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", style.dot)} aria-hidden="true" />
      {style.label}
    </span>
  );
}

/**
 * The "Problem" badge.
 *
 * Deliberately NOT an `account_status` value. ADR-010 Decision 4 keeps problems
 * out of `accounts.status`: the column is the persisted operational status and
 * reporting a problem never writes to it. So an account carrying an open problem
 * still reads `healthy` in its own row, and the two facts are only ever combined
 * at read time — the same conjunction `evaluateAllocation` makes.
 *
 * Red rather than orange: an active problem blocks allocation outright, exactly
 * as an unhealthy status does, and the badge should not suggest otherwise.
 */
export const ACTIVE_PROBLEM_STYLE: BadgeStyle = {
  label: "Problem",
  className: "bg-danger-subtle text-danger",
  dot: "bg-danger",
};

/**
 * Which badge an account shows.
 *
 * Exported so the rule can be asserted directly. Keeping it inside the
 * component would leave the only test of "does an open problem hide Healthy" a
 * render assertion, and the decision is the part that regresses.
 */
export function accountBadgeStyle(
  status: AccountRow["status"],
  hasActiveProblem: boolean,
): BadgeStyle {
  return hasActiveProblem && status === "healthy"
    ? ACTIVE_PROBLEM_STYLE
    : ACCOUNT_STATUS_STYLES[status];
}

export function AccountStatusBadge({
  status,
  hasActiveProblem = false,
  className,
}: {
  status: AccountRow["status"];
  /**
   * True when the account has at least one problem in a blocking status.
   *
   * Passed in rather than read from `status`, because a problem lives in the
   * `issues` table and has no column here. It overrides a healthy badge: an
   * account with an open problem reading "Healthy" is the one thing this badge
   * must never say.
   *
   * A status that is already unhealthy wins, mirroring `evaluateAllocation` —
   * the more specific reason is the one a worker can act on directly.
   */
  hasActiveProblem?: boolean;
  className?: string;
}) {
  return <Badge style={accountBadgeStyle(status, hasActiveProblem)} className={className} />;
}

export function ProfileStatusBadge({
  status,
  notForSale = false,
  className,
}: {
  status: ProfileRow["status"];
  /**
   * True when this profile is above the account's sellable slot count.
   *
   * Passed in rather than read from `status`, because sellability is derived
   * from profile_number and profile_slots and has no column of its own. It
   * overrides the status badge: a slot that is not stock reading "Available"
   * would be actively misleading.
   */
  notForSale?: boolean;
  className?: string;
}) {
  return (
    <Badge
      style={notForSale ? NOT_FOR_SALE_STYLE : PROFILE_STATUS_STYLES[status]}
      className={className}
    />
  );
}

/** Human-readable account status, for places a badge does not fit. */
export function accountStatusLabel(status: AccountRow["status"]): string {
  return ACCOUNT_STATUS_STYLES[status].label;
}

/** Every account status, for filter and edit controls. */
export const ACCOUNT_STATUS_OPTIONS = Object.entries(ACCOUNT_STATUS_STYLES).map(
  ([value, style]) => ({ value: value as AccountRow["status"], label: style.label }),
);
