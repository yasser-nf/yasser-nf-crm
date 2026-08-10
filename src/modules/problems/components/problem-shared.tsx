import { cn } from "@/utils/cn";
import type { ProblemSeverity, ProblemStatus } from "../services/problem-lifecycle";

/**
 * Shared problem presentation.
 *
 * Every map is `Record<Union, …>`, so adding a status or severity without a
 * colour becomes a compile error rather than an unstyled badge.
 */

const BADGE = "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-caption font-medium";

export const PROBLEM_TYPE_LABELS: Record<string, string> = {
  payment_problem: "Payment problem",
  incorrect_password: "Incorrect password",
  invalid_email: "Invalid email",
  something_went_wrong: "Something went wrong",
  other: "Other",
};

const STATUS_STYLES: Record<ProblemStatus, { className: string; label: string }> = {
  open: { className: "bg-danger-subtle text-danger", label: "Open" },
  in_progress: { className: "bg-primary-subtle text-primary", label: "In progress" },
  waiting: { className: "bg-warning-subtle text-warning", label: "Waiting" },
  resolved: { className: "bg-success-subtle text-success", label: "Resolved" },
  closed: { className: "bg-surface-raised text-foreground-muted", label: "Closed" },
  cancelled: { className: "bg-neutral-subtle text-foreground-subtle", label: "Cancelled" },
};

export function ProblemStatusBadge({ status }: { status: ProblemStatus }) {
  const style = STATUS_STYLES[status];

  return <span className={cn(BADGE, style.className)}>{style.label}</span>;
}

const SEVERITY_STYLES: Record<ProblemSeverity, { className: string; label: string }> = {
  low: { className: "bg-surface-raised text-foreground-muted", label: "Low" },
  medium: { className: "bg-primary-subtle text-primary", label: "Medium" },
  high: { className: "bg-warning-subtle text-warning", label: "High" },
  critical: { className: "bg-danger-subtle text-danger", label: "Critical" },
};

export function ProblemSeverityBadge({ severity }: { severity: ProblemSeverity }) {
  const style = SEVERITY_STYLES[severity];

  return (
    <span className={cn(BADGE, style.className)}>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          severity === "critical"
            ? "bg-danger"
            : severity === "high"
              ? "bg-warning"
              : severity === "medium"
                ? "bg-primary"
                : "bg-neutral",
        )}
        aria-hidden="true"
      />
      {style.label}
    </span>
  );
}

/**
 * How long a problem has been open, in the coarsest useful unit.
 *
 * Pure and exported so the list, the detail screen and the tests all agree.
 * Age is measured to resolution when resolved — a problem fixed in an hour a
 * year ago is not "365 days old", and showing it that way would make every old
 * record look like a failure.
 */
export function problemAge(createdAt: Date, resolvedAt: Date | null, now: Date): string {
  const end = resolvedAt ?? now;
  const ms = Math.max(end.getTime() - createdAt.getTime(), 0);

  const minutes = Math.floor(ms / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;

  const months = Math.floor(days / 30);
  return `${months}mo`;
}

export function formatDateTime(value: Date | string | null): string {
  return value
    ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";
}
