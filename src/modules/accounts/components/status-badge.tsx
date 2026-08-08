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

function Badge({ style, className }: { style: BadgeStyle; className?: string }) {
  return (
    <span className={cn(BADGE_BASE, style.className, className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", style.dot)} aria-hidden="true" />
      {style.label}
    </span>
  );
}

export function AccountStatusBadge({
  status,
  className,
}: {
  status: AccountRow["status"];
  className?: string;
}) {
  return <Badge style={ACCOUNT_STATUS_STYLES[status]} className={className} />;
}

export function ProfileStatusBadge({
  status,
  className,
}: {
  status: ProfileRow["status"];
  className?: string;
}) {
  return <Badge style={PROFILE_STATUS_STYLES[status]} className={className} />;
}

/** Human-readable account status, for places a badge does not fit. */
export function accountStatusLabel(status: AccountRow["status"]): string {
  return ACCOUNT_STATUS_STYLES[status].label;
}

/** Every account status, for filter and edit controls. */
export const ACCOUNT_STATUS_OPTIONS = Object.entries(ACCOUNT_STATUS_STYLES).map(
  ([value, style]) => ({ value: value as AccountRow["status"], label: style.label }),
);
