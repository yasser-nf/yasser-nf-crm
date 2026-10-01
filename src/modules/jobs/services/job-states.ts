/**
 * The job lifecycle, as pure rules (M08 jobs). docs/JOBS_MODULE.md §3.
 *
 * No database, no clock: the caller passes `now`. The repository enforces the
 * same transitions in SQL (every UPDATE names the status it moves FROM), and
 * the table's check constraints enforce the invariants; this module is the one
 * written-down list both are checked against.
 */

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "cancelled"];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Why a job moves. Each cause permits exactly the moves listed for it. */
export type JobTransitionCause =
  | "claim"
  | "heartbeat"
  | "complete"
  | "retry"
  | "fail"
  | "cancel"
  | "recover_requeue"
  | "recover_fail"
  | "recover_completed";

/**
 *   queued   ──claim──────────────▶ running
 *   running  ──heartbeat──────────▶ running          (same owner)
 *   running  ──complete───────────▶ succeeded        (owner)
 *   running  ──retry──────────────▶ queued           (owner; attempts remain)
 *   running  ──fail───────────────▶ failed           (owner; permanent or exhausted)
 *   queued   ──cancel─────────────▶ cancelled        (Super Admin)
 *   running  ──recover_requeue────▶ queued           (heartbeat stale; no receipt; attempts remain)
 *   running  ──recover_fail───────▶ failed           (heartbeat stale; no receipt; exhausted)
 *   running  ──recover_completed──▶ succeeded        (heartbeat stale; the receipt proves it committed)
 *
 * Nothing leaves a terminal status. A running job cannot be cancelled: its
 * work may already have committed, and saying "cancelled" would be a lie.
 */
const TRANSITIONS: Readonly<Record<JobTransitionCause, readonly [JobStatus, JobStatus]>> = {
  claim: ["queued", "running"],
  heartbeat: ["running", "running"],
  complete: ["running", "succeeded"],
  retry: ["running", "queued"],
  fail: ["running", "failed"],
  cancel: ["queued", "cancelled"],
  recover_requeue: ["running", "queued"],
  recover_fail: ["running", "failed"],
  recover_completed: ["running", "succeeded"],
};

export function transitionFor(cause: JobTransitionCause): readonly [JobStatus, JobStatus] {
  return TRANSITIONS[cause];
}

/** Whether `cause` may move a job out of `from`. */
export function canTransition(from: JobStatus, cause: JobTransitionCause): boolean {
  return TRANSITIONS[cause][0] === from;
}

/** Named priorities. Higher is claimed first. */
export const JOB_PRIORITIES = { urgent: 10, normal: 0, low: -10 } as const;
export type JobPriorityName = keyof typeof JOB_PRIORITIES;

export function priorityName(priority: number): JobPriorityName | "custom" {
  const found = (Object.keys(JOB_PRIORITIES) as JobPriorityName[]).find(
    (name) => JOB_PRIORITIES[name] === priority,
  );
  return found ?? "custom";
}

/** A worker must heartbeat well inside this; past it, the job is presumed abandoned. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/** How often the reference worker loop heartbeats a running job. */
export const HEARTBEAT_EVERY_MS = 30 * 1000;

/**
 * Backoff before attempt `attempt + 1`, after `attempt` failed: 30 s, 1 min,
 * 2 min … capped at 15 min. Deterministic — the claim order is already the
 * tie-breaker, and a predictable retry time is easier to reason about.
 * Mirrored in SQL by `retryDelaySql` in the repository; a test keeps them equal.
 */
export const RETRY_BASE_SECONDS = 30;
export const RETRY_MAX_SECONDS = 15 * 60;

export function retryDelaySeconds(attempt: number): number {
  const safe = Math.max(1, Math.trunc(attempt));
  return Math.min(RETRY_BASE_SECONDS * 2 ** (safe - 1), RETRY_MAX_SECONDS);
}

/**
 * What the Super Admin sees. Derived, never stored: "retrying" is a queued job
 * that has already been tried, "stale" a running one whose worker went quiet.
 */
export type JobDisplayState =
  "queued" | "retrying" | "running" | "stale" | "succeeded" | "failed" | "cancelled";

export function displayState(
  job: {
    readonly status: JobStatus;
    readonly attempts: number;
    readonly heartbeatAt: Date | null;
  },
  now: Date,
  staleAfterMs: number = STALE_AFTER_MS,
): JobDisplayState {
  switch (job.status) {
    case "queued":
      return job.attempts > 0 ? "retrying" : "queued";
    case "running":
      return job.heartbeatAt !== null && now.getTime() - job.heartbeatAt.getTime() > staleAfterMs
        ? "stale"
        : "running";
    default:
      return job.status;
  }
}
