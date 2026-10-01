import { escapeLike } from "@/utils/like";
import {
  JOB_STATUSES,
  displayState,
  priorityName,
  type JobDisplayState,
  type JobStatus,
} from "./job-states";

/**
 * What the jobs page may see (M08 jobs). Client-safe: no server imports.
 *
 * A job leaves the server only as `JobListItem`. Deliberately absent: the
 * payload (whatever a job type carries), the result, the idempotency key, and
 * above all the claim token — the proof of ownership a worker presents.
 */

export interface JobListItem {
  readonly id: string;
  readonly type: string;
  readonly status: JobStatus;
  readonly state: JobDisplayState;
  readonly priority: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly availableAt: string;
  readonly startedAt: string | null;
  readonly heartbeatAt: string | null;
  readonly finishedAt: string | null;
  readonly cancelledAt: string | null;
  readonly recoveredAt: string | null;
  readonly claimedBy: string | null;
  readonly lastError: string | null;
  readonly lastErrorCode: string | null;
  /** Whether a Super Admin may withdraw it now — queued only. */
  readonly cancellable: boolean;
}

interface JobLike {
  readonly id: string;
  readonly type: string;
  readonly status: JobStatus;
  readonly priority: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: Date;
  readonly availableAt: Date;
  readonly startedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly finishedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly recoveredAt: Date | null;
  readonly claimedBy: string | null;
  readonly lastError: string | null;
  readonly lastErrorCode: string | null;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function toJobListItem(job: JobLike, now: Date): JobListItem {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    state: displayState(job, now),
    priority: priorityName(job.priority),
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt.toISOString(),
    availableAt: job.availableAt.toISOString(),
    startedAt: iso(job.startedAt),
    heartbeatAt: iso(job.heartbeatAt),
    finishedAt: iso(job.finishedAt),
    cancelledAt: iso(job.cancelledAt),
    recoveredAt: iso(job.recoveredAt),
    claimedBy: job.claimedBy,
    lastError: job.lastError,
    lastErrorCode: job.lastErrorCode,
    cancellable: job.status === "queued",
  };
}

export const JOB_STATE_LABELS: Record<JobDisplayState, string> = {
  queued: "Queued",
  retrying: "Retrying",
  running: "Running",
  stale: "Stale",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const JOBS_PAGE_SIZE = 25;

export interface JobsFilterInput {
  readonly type?: string | undefined;
  readonly status?: JobStatus | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly search?: string | undefined;
  readonly offset: number;
}

type RawParams = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TYPE = /^[a-z][a-z0-9_.]{0,63}$/;

function read(params: RawParams, key: string): string | undefined {
  const value = params[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.trim() ? first.trim() : undefined;
}

/** The instant a UTC day starts, or null for anything that is not a real date. */
export function utcDay(day: string): Date | null {
  const match = DAY.exec(day);

  if (!match) {
    return null;
  }

  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const instant = new Date(Date.UTC(year, month - 1, date));

  return instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === date
    ? instant
    : null;
}

/** URL → filter. Anything unrecognised is dropped, never passed through. */
export function parseJobsFilter(params: RawParams): JobsFilterInput {
  const offset = Number.parseInt(read(params, "offset") ?? "0", 10);
  const type = read(params, "type");
  const from = read(params, "from");
  const to = read(params, "to");

  return {
    type: type && TYPE.test(type) ? type : undefined,
    status: JOB_STATUSES.find((status) => status === read(params, "status")),
    from: from && utcDay(from) ? from : undefined,
    to: to && utcDay(to) ? to : undefined,
    search: read(params, "search")?.slice(0, 100),
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}

export function hasActiveJobFilters(filter: JobsFilterInput): boolean {
  return Boolean(filter.type || filter.status || filter.from || filter.to || filter.search);
}

/** The filter as the repository wants it: UTC instants, an exact id or an escaped pattern. */
export function toRepositoryFilter(filter: JobsFilterInput) {
  const start = filter.from ? (utcDay(filter.from) ?? undefined) : undefined;
  const toDay = filter.to ? utcDay(filter.to) : null;
  const search = filter.search?.trim();

  return {
    type: filter.type,
    status: filter.status,
    createdFrom: start,
    /* `to` is inclusive: everything before the next UTC midnight. */
    createdBefore: toDay ? new Date(toDay.getTime() + 24 * 60 * 60 * 1000) : undefined,
    searchId: search && UUID.test(search) ? search.toLowerCase() : undefined,
    searchContains: search && !UUID.test(search) ? `%${escapeLike(search)}%` : undefined,
    limit: JOBS_PAGE_SIZE,
    offset: filter.offset,
  };
}

/** A from-day after a to-day is a mistake, not an empty result. */
export function invertedRange(filter: JobsFilterInput): boolean {
  return Boolean(filter.from && filter.to && filter.from > filter.to);
}
