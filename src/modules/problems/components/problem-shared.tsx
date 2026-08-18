import {
  PROBLEM_TYPE_LABELS,
  ProblemSeverityBadgeBase,
  ProblemStatusBadgeBase,
} from "@/shared/ui/problem-badges";
import type { ProblemSeverity, ProblemStatus } from "../services/problem-lifecycle";

/**
 * Shared problem presentation.
 *
 * The badges themselves live in `@/shared/ui/problem-badges`, shared with Quick
 * Replace's problems panel — a Client Component, which cannot import this
 * module's barrel because that barrel re-exports `server-only` services.
 *
 * These wrappers stay because the module barrel, the problems table and the
 * detail screen all reference them by name. They also pin the design system's
 * unions to the DOMAIN types: if `ProblemStatus` gains a member the design
 * system has no colour for, these stop typechecking rather than rendering an
 * unstyled badge.
 */

export { PROBLEM_TYPE_LABELS };

export function ProblemStatusBadge({ status }: { status: ProblemStatus }) {
  return <ProblemStatusBadgeBase status={status} />;
}

export function ProblemSeverityBadge({ severity }: { severity: ProblemSeverity }) {
  return <ProblemSeverityBadgeBase severity={severity} />;
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
