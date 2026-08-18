import { cn } from "@/utils/cn";

/**
 * The visual vocabulary for a problem's status and severity.
 *
 * Extracted here for the same reason `profile-state.tsx` was: Quick Replace
 * shows account problems from a Client Component, which cannot import the
 * problems barrel — that barrel re-exports `server-only` services, and pulling
 * it into the client bundle is a build error.
 *
 * The alternative was a second set of badges in the replacement screen, which
 * would be a second interpretation of the same six statuses, free to drift from
 * the Problems module's. One definition, two consumers.
 *
 * No lifecycle logic lives here. Which statuses block an account is
 * `BLOCKING_STATUSES` in the problems module, and nothing in the design system
 * second-guesses it.
 */

const BADGE = "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-caption font-medium";

/**
 * Operator-facing names for the issue types.
 *
 * Keyed loosely by string rather than by the enum: `issue_type` is a database
 * enum that can gain a member in a migration, and an unlabelled type should
 * degrade to its raw value rather than crash the screen showing it.
 */
export const PROBLEM_TYPE_LABELS: Record<string, string> = {
  payment_problem: "Payment problem",
  incorrect_password: "Incorrect password",
  invalid_email: "Invalid email",
  something_went_wrong: "Something went wrong",
  other: "Other",
};

/**
 * Kept structurally identical to the domain's `ProblemStatus` / `ProblemSeverity`.
 *
 * Deliberately not imported from the problems module: the design system must not
 * depend on a feature module. Consumers index these maps with the domain types,
 * so a status added there without a colour here stops typechecking.
 */
export type ProblemStatusName =
  "open" | "in_progress" | "waiting" | "resolved" | "closed" | "cancelled";

export type ProblemSeverityName = "low" | "medium" | "high" | "critical";

export const PROBLEM_STATUS_STYLES: Record<
  ProblemStatusName,
  { className: string; label: string }
> = {
  open: { className: "bg-danger-subtle text-danger", label: "Open" },
  in_progress: { className: "bg-primary-subtle text-primary", label: "In progress" },
  waiting: { className: "bg-warning-subtle text-warning", label: "Waiting" },
  resolved: { className: "bg-success-subtle text-success", label: "Resolved" },
  closed: { className: "bg-surface-raised text-foreground-muted", label: "Closed" },
  cancelled: { className: "bg-neutral-subtle text-foreground-subtle", label: "Cancelled" },
};

export const PROBLEM_SEVERITY_STYLES: Record<
  ProblemSeverityName,
  { className: string; label: string; dot: string }
> = {
  low: { className: "bg-surface-raised text-foreground-muted", label: "Low", dot: "bg-neutral" },
  medium: { className: "bg-primary-subtle text-primary", label: "Medium", dot: "bg-primary" },
  high: { className: "bg-warning-subtle text-warning", label: "High", dot: "bg-warning" },
  critical: { className: "bg-danger-subtle text-danger", label: "Critical", dot: "bg-danger" },
};

export function ProblemStatusBadgeBase({ status }: { status: ProblemStatusName }) {
  const style = PROBLEM_STATUS_STYLES[status];

  return <span className={cn(BADGE, style.className)}>{style.label}</span>;
}

export function ProblemSeverityBadgeBase({ severity }: { severity: ProblemSeverityName }) {
  const style = PROBLEM_SEVERITY_STYLES[severity];

  return (
    <span className={cn(BADGE, style.className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", style.dot)} aria-hidden="true" />
      {style.label}
    </span>
  );
}
