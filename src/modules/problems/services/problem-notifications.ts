import "server-only";

import type { IssueRow } from "@/lib/drizzle/schema";
import { logger } from "@/lib/logger";
import type { AuditContext } from "@/modules/audit";
import { notificationsService } from "@/modules/notifications";
import { PROBLEM_TYPE_LABELS } from "@/shared/ui/problem-badges";
import { problemsRepository } from "../repositories/problems.repository";

/**
 * The problem events worth telling someone about (M05).
 *
 * Called by the Problems services AFTER their write has succeeded, exactly
 * where each already records its audit entry, so a notification exists only for
 * a change that really happened. Bulk actions reach these through the same
 * single-problem services and so notify the same way — there is no second path.
 *
 * Who hears about what, and why:
 *
 *   reported   every active Super Admin   they triage and assign new problems
 *   assigned   the new assignee           it is now their work
 *   resolved   the reporter and assignee  the account they flagged works again
 *   reopened   the assignee, else the     a fix that did not hold needs an owner
 *              Super Admins
 *
 * Never the person who acted — the repository excludes them — and never an
 * inactive or archived user.
 *
 * What a notice says: the problem type, the account's email and who acted.
 * NEVER the description or the resolution note. Those are free text an
 * operator types, and a password pasted into one must not be copied into
 * somebody else's notifications, where no redaction would ever reach it.
 *
 * A failed notification never fails the problem operation: `notifyOrWarn` logs
 * it, the same contract as the audit trail.
 */

function typeLabel(problem: IssueRow): string {
  return PROBLEM_TYPE_LABELS[problem.issueType] ?? problem.issueType;
}

/** "account@example.com — resolved by Yasser". The email is omitted if it cannot be read. */
async function describe(problem: IssueRow, verb: string, context: AuditContext): Promise<string> {
  const detail = await problemsRepository.findDetail(problem.id);
  const who = context.actor ? ` by ${context.actor.displayName}` : "";
  const account = detail.ok ? `${detail.value.accountEmail} — ` : "";

  return `${account}${verb}${who}`;
}

function entity(problem: IssueRow) {
  return { type: "issue" as const, id: problem.id };
}

async function reported(problem: IssueRow, context: AuditContext): Promise<void> {
  await notificationsService.notifyOrWarn({
    type: "problem_reported",
    recipients: { role: "super_admin" },
    actor: context.actor,
    title: `New problem: ${typeLabel(problem)}`,
    body: await describe(problem, "reported", context),
    entity: entity(problem),
    dedupeKey: `problem_reported:${problem.id}`,
  });
}

async function assigned(before: IssueRow, after: IssueRow, context: AuditContext): Promise<void> {
  if (after.assignedTo === null || after.assignedTo === before.assignedTo) {
    return;
  }

  await notificationsService.notifyOrWarn({
    type: "problem_assigned",
    recipients: { userIds: [after.assignedTo] },
    actor: context.actor,
    title: `Assigned to you: ${typeLabel(after)}`,
    body: await describe(after, "assigned", context),
    entity: entity(after),
    /* The same person can be assigned the same problem again later; that is a new event. */
    dedupeKey: `problem_assigned:${after.id}:${after.updatedAt.toISOString()}`,
  });
}

async function resolved(after: IssueRow, context: AuditContext): Promise<void> {
  const recipients = [
    ...new Set([after.reportedBy, after.assignedTo].filter((id): id is string => id !== null)),
  ];

  if (recipients.length === 0) {
    return;
  }

  await notificationsService.notifyOrWarn({
    type: "problem_resolved",
    recipients: { userIds: recipients },
    actor: context.actor,
    title: `Resolved: ${typeLabel(after)}`,
    body: await describe(after, "resolved", context),
    entity: entity(after),
    dedupeKey: `problem_resolved:${after.id}:${(after.resolvedAt ?? after.updatedAt).toISOString()}`,
  });
}

async function reopened(after: IssueRow, context: AuditContext): Promise<void> {
  await notificationsService.notifyOrWarn({
    type: "problem_reopened",
    recipients: after.assignedTo ? { userIds: [after.assignedTo] } : { role: "super_admin" },
    actor: context.actor,
    title: `Reopened: ${typeLabel(after)}`,
    body: await describe(after, "reopened", context),
    entity: entity(after),
    /* reopen_count only ever grows, so it names each reopening exactly once. */
    dedupeKey: `problem_reopened:${after.id}:${after.reopenCount}`,
  });
}

/** A deleted problem's notices would link to a page that no longer exists. */
async function removed(problemId: string): Promise<void> {
  const result = await notificationsService.removeForEntity("issue", problemId);

  /* Stale notices are harmless — the link shows "not found" — so this only warns. */
  if (!result.ok) {
    logger.warn("Notifications for a deleted problem could not be removed", {
      problemId,
      code: result.error.code,
    });
  }
}

export const problemNotifications = { reported, assigned, resolved, reopened, removed } as const;
