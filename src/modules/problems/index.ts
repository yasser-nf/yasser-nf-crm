/**
 * Problems module — public API. ADR-003 Rule 2.
 *
 * The single source of truth for every account problem. The M08 brief: no
 * module may create or resolve problems directly.
 *
 * The repository is NOT exported. A caller holding it could write an `issues`
 * row without a transition check, an audit entry or a permission check — and
 * all three are what make this module the source of truth rather than just a
 * table with a screen.
 */
export { problemsService } from "./services/problems.service";
export { problemAssignmentService } from "./services/problem-assignment.service";
export { problemResolutionService } from "./services/problem-resolution.service";
export { bulkProblemsService } from "./services/bulk-problems.service";
export { problemTimelineService } from "./services/problem-timeline.service";

export type { TimelineEntry, TimelineKind } from "./services/problem-timeline.service";

export {
  ACTIVE_STATUSES,
  BLOCKING_STATUSES,
  PROBLEM_SEVERITIES,
  PROBLEM_STATUSES,
  allowedTransitions,
  canTransition,
  explainRefusal,
  isBlocking,
  isReopen,
  requiresResolutionNote,
  type ProblemSeverity,
  type ProblemStatus,
} from "./services/problem-lifecycle";

export type { ProblemFilter, ProblemListEntry } from "./repositories/problems.repository";

export { ProblemsTable, ProblemsFilters } from "./components/problems-table";
export { ProblemDetailView } from "./components/problem-detail";
export { ReportProblemDialog } from "./components/report-problem-dialog";
export { ProblemSeverityBadge, ProblemStatusBadge, problemAge } from "./components/problem-shared";

export {
  addNoteSchema,
  createProblemSchema,
  problemSeveritySchema,
  problemStatusSchema,
  problemTypeSchema,
  resolveProblemSchema,
  updateProblemSchema,
  type CreateProblemInput,
} from "./validation/problem.schema";
