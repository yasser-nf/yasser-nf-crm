/**
 * Jobs module — public API (M08 jobs). docs/JOBS_MODULE.md.
 *
 * Two audiences:
 *
 *   server code and workers   `jobQueue` — enqueue, claim, heartbeat,
 *                             complete, fail, retry, recoverStale, processNext;
 *                             `defineJob` / `createRegistry` for job types
 *   the jobs page             `jobsService` (Super Admin) and its components
 *
 * The repository is NOT exported: every state change goes through `jobQueue`,
 * which validates the transition, the claim token and the payload.
 */
export {
  jobQueue,
  type Claim,
  type EnqueueInput,
  type EnqueueOptions,
  type ProcessOutcome,
  type RecoveryReport,
} from "./services/job-queue";
export {
  assertSafePayload,
  createRegistry,
  defineJob,
  type AnyJobDefinition,
  type JobContext,
  type JobDefinition,
  type JobRegistry,
} from "./services/job-definition";
export { JobRetryableError, classifyFailure, type FailureSummary } from "./services/job-errors";
export {
  HEARTBEAT_EVERY_MS,
  JOB_PRIORITIES,
  JOB_STATUSES,
  STALE_AFTER_MS,
  canTransition,
  displayState,
  isTerminal,
  retryDelaySeconds,
  transitionFor,
  type JobDisplayState,
  type JobPriorityName,
  type JobStatus,
  type JobTransitionCause,
} from "./services/job-states";
export { jobsService } from "./services/jobs.service";
export {
  JOBS_PAGE_SIZE,
  JOB_STATE_LABELS,
  JOB_STATUS_LABELS,
  hasActiveJobFilters,
  parseJobsFilter,
  toJobListItem,
  type JobListItem,
  type JobsFilterInput,
} from "./services/job-view";
export { JobsFilters } from "./components/jobs-filters";
export { JobsTable, JobDetailDialog } from "./components/jobs-table";
