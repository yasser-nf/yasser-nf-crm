/**
 * Problem lifecycle.
 *
 * Pure — no database, no clock, no authorization. It answers one question: may
 * a problem move from this status to that one. Kept separate from the services
 * so it is unit testable without a server environment, the same split as
 * `presence.ts` in M06 and `retention.ts` in M07.
 *
 * No document defined these transitions. ADR-010 Decision 1 records the graph
 * and its reasoning; this file is the only place it is expressed, so the rule
 * cannot drift between the service that applies it and the screen that offers
 * the buttons.
 */

export const PROBLEM_STATUSES = [
  "open",
  "in_progress",
  "waiting",
  "resolved",
  "closed",
  "cancelled",
] as const;

export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

export const PROBLEM_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type ProblemSeverity = (typeof PROBLEM_SEVERITIES)[number];

/**
 * Statuses that block allocation.
 *
 * The account-health rule: a problem still being worked on makes its account
 * unallocatable. Resolved, closed and cancelled do not — the work is finished
 * or was never real, and continuing to block would make every historical
 * problem permanently disable an account.
 */
export const BLOCKING_STATUSES: readonly ProblemStatus[] = ["open", "in_progress", "waiting"];

/** Statuses that count as still being worked on, for list filters and counts. */
export const ACTIVE_STATUSES = BLOCKING_STATUSES;

export function isBlocking(status: ProblemStatus): boolean {
  return BLOCKING_STATUSES.includes(status);
}

/**
 * The transition graph.
 *
 * `cancelled` is terminal for everyone except a Super Admin closing it — see
 * `allowedTransitions`. Every other terminal-looking state can be reopened,
 * because a fault that comes back is the normal case and forcing a new problem
 * would lose the connection to its history.
 */
const TRANSITIONS: Record<ProblemStatus, readonly ProblemStatus[]> = {
  open: ["in_progress", "waiting", "resolved", "cancelled"],
  in_progress: ["waiting", "resolved", "cancelled"],
  waiting: ["in_progress", "resolved", "cancelled"],
  /* Reopening returns to `open`, never straight to in_progress: somebody has to pick it up again. */
  resolved: ["closed", "open"],
  closed: ["open"],
  cancelled: [],
};

/**
 * Transitions available from a status.
 *
 * `isSuperAdmin` exists for exactly one rule: the M08 brief states that Workers
 * may not close cancelled problems, which implies somebody can. Closing a
 * cancelled problem is therefore a Super Admin action and appears nowhere else.
 */
export function allowedTransitions(
  from: ProblemStatus,
  isSuperAdmin: boolean,
): readonly ProblemStatus[] {
  if (from === "cancelled") {
    return isSuperAdmin ? ["closed"] : [];
  }

  return TRANSITIONS[from];
}

export function canTransition(
  from: ProblemStatus,
  to: ProblemStatus,
  isSuperAdmin: boolean,
): boolean {
  return allowedTransitions(from, isSuperAdmin).includes(to);
}

/** Whether a move counts as reopening, so the counter increments exactly there. */
export function isReopen(from: ProblemStatus, to: ProblemStatus): boolean {
  return (from === "resolved" || from === "closed") && to === "open";
}

/** Resolving demands an explanation. A "resolved" nobody explained teaches nobody. */
export function requiresResolutionNote(to: ProblemStatus): boolean {
  return to === "resolved";
}

/** Human-readable reason a transition was refused, for the error message. */
export function explainRefusal(from: ProblemStatus, to: ProblemStatus): string {
  if (from === to) {
    return `This problem is already ${to.replace(/_/g, " ")}.`;
  }

  if (from === "cancelled") {
    return "A cancelled problem cannot be changed. Report a new one instead.";
  }

  return `A problem cannot go from ${from.replace(/_/g, " ")} to ${to.replace(/_/g, " ")}.`;
}
