import "server-only";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { problemsRepository, type TimelineAuditRow } from "../repositories/problems.repository";
import { addNoteSchema } from "../validation/problem.schema";
import { assertMayMutate } from "./problems.service";

/**
 * Problem timeline.
 *
 * ADR-010 Decision 3: the timeline is DERIVED, not stored. Its two sources are
 * `audit_logs` filtered to this problem, and `issue_notes`. There is no third
 * table.
 *
 * The M08 brief asks for a timeline and, in the same breath, forbids
 * duplicating timeline and audit structures. Audit already records every
 * mutation with before and after — the timeline is those same rows read along a
 * different axis, plus the comments. The same reasoning that produced the M06
 * activity feed.
 *
 * Loaded only when a detail page opens, per the M08 performance rule. Nothing
 * in the list touches it.
 */

export type TimelineKind =
  | "created"
  | "assigned"
  | "unassigned"
  | "reassigned"
  | "status_changed"
  | "severity_changed"
  | "reopened"
  | "resolved"
  | "closed"
  | "cancelled"
  | "note"
  | "updated"
  | "deleted";

export interface TimelineEntry {
  readonly id: string;
  readonly kind: TimelineKind;
  readonly summary: string;
  readonly body: string | null;
  readonly actorName: string | null;
  readonly createdAt: Date;
}

function readField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "string" ? raw : null;
}

function readNumber(value: unknown, field: string): number | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "number" ? raw : null;
}

function label(value: string | null): string {
  return value ? value.replace(/_/g, " ") : "nothing";
}

/**
 * Turns one audit row into a human sentence.
 *
 * An audit entry says what the row looked like before and after. A timeline
 * says what somebody did. This is the translation, and it is why the timeline
 * needs no storage of its own: every event it shows is already implied by a
 * diff that was recorded for other reasons.
 */
function describe(row: TimelineAuditRow): TimelineEntry {
  const base = {
    id: row.id,
    actorName: row.actorName,
    createdAt: row.createdAt,
    body: null,
  };

  if (row.action === "create") {
    return { ...base, kind: "created", summary: "Problem reported" };
  }

  if (row.action === "delete") {
    return { ...base, kind: "deleted", summary: "Problem deleted" };
  }

  const beforeStatus = readField(row.before, "status");
  const afterStatus = readField(row.after, "status");
  const beforeAssignee =
    readField(row.before, "assignedTo") ?? readField(row.before, "assigned_to");
  const afterAssignee = readField(row.after, "assignedTo") ?? readField(row.after, "assigned_to");
  const beforeSeverity = readField(row.before, "severity");
  const afterSeverity = readField(row.after, "severity");
  const beforeReopens =
    readNumber(row.before, "reopenCount") ?? readNumber(row.before, "reopen_count");
  const afterReopens =
    readNumber(row.after, "reopenCount") ?? readNumber(row.after, "reopen_count");

  if (beforeReopens !== null && afterReopens !== null && afterReopens > beforeReopens) {
    return {
      ...base,
      kind: "reopened",
      summary: `Reopened (time ${afterReopens})`,
    };
  }

  if (beforeAssignee !== afterAssignee) {
    if (!beforeAssignee && afterAssignee) {
      return { ...base, kind: "assigned", summary: "Assigned" };
    }

    if (beforeAssignee && !afterAssignee) {
      return { ...base, kind: "unassigned", summary: "Unassigned" };
    }

    return { ...base, kind: "reassigned", summary: "Reassigned" };
  }

  if (beforeSeverity !== afterSeverity && afterSeverity) {
    return {
      ...base,
      kind: "severity_changed",
      summary: `Severity changed from ${label(beforeSeverity)} to ${label(afterSeverity)}`,
    };
  }

  if (beforeStatus !== afterStatus && afterStatus) {
    const kind: TimelineKind =
      afterStatus === "resolved"
        ? "resolved"
        : afterStatus === "closed"
          ? "closed"
          : afterStatus === "cancelled"
            ? "cancelled"
            : "status_changed";

    return {
      ...base,
      kind,
      summary: `Status changed from ${label(beforeStatus)} to ${label(afterStatus)}`,
      body: afterStatus === "resolved" ? readField(row.after, "resolutionNote") : null,
    };
  }

  return { ...base, kind: "updated", summary: "Problem updated" };
}

/**
 * The merged timeline, newest first.
 *
 * Both sources are already ordered; merging in memory is correct here because
 * each is bounded — the audit read is limited and a problem's notes are few. A
 * SQL UNION would be needed only if either side could be large enough for the
 * limit to cut across both, which is the case the M06 activity feed had and
 * this one does not.
 */
async function forProblem(
  problemId: string,
  actor: AppUser | null,
): Promise<Result<readonly TimelineEntry[]>> {
  if (!actor || !roleHasPermission(actor.role, PERMISSIONS.VIEW_PROBLEMS)) {
    return fail(
      new ForbiddenError("Not permitted to view this timeline", {
        userMessage: "You do not have permission to view problems.",
      }),
    );
  }

  const [history, notes] = await Promise.all([
    problemsRepository.historyFor(problemId),
    problemsRepository.notesFor(problemId),
  ]);

  const entries: TimelineEntry[] = [];

  if (history.ok) {
    entries.push(...history.value.map(describe));
  }

  if (notes.ok) {
    entries.push(
      ...notes.value.map((note) => ({
        id: note.id,
        kind: "note" as const,
        summary: "Note added",
        body: note.body,
        actorName: note.authorName,
        createdAt: note.createdAt,
      })),
    );
  }

  entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return ok(entries);
}

/**
 * Adds an internal note.
 *
 * Append-only: there is no edit and no delete anywhere in this module, and the
 * table has no `updated_at`. A note that can change is not a record of what
 * somebody said at the time.
 *
 * Ownership applies — the M08 brief allows Workers to add notes only to
 * problems assigned to them.
 */
async function addNote(
  problemId: string,
  input: unknown,
  context: AuditContext,
): Promise<Result<TimelineEntry>> {
  if (!context.actor) {
    return fail(new ForbiddenError("No signed-in user to add a note"));
  }

  const parsed = addNoteSchema.safeParse(input);

  if (!parsed.success) {
    return fail(
      new ValidationError("Note is not valid", {
        fieldErrors: { body: parsed.error.issues[0]?.message ?? "Required" },
      }),
    );
  }

  const problem = await problemsRepository.findById(problemId);

  if (!problem.ok) {
    return problem;
  }

  const allowed = assertMayMutate(context.actor, problem.value, "add a note to");

  if (!allowed.ok) {
    return allowed;
  }

  const note = await problemsRepository.addNote({
    issueId: problemId,
    userId: context.actor.id,
    body: parsed.data.body,
  });

  if (!note.ok) {
    return note;
  }

  return ok({
    id: note.value.id,
    kind: "note",
    summary: "Note added",
    body: note.value.body,
    actorName: context.actor.displayName,
    createdAt: note.value.createdAt,
  });
}

export const problemTimelineService = { forProblem, addNote } as const;
