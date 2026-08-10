"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import type { AppError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import { problemAssignmentService } from "../services/problem-assignment.service";
import { problemResolutionService } from "../services/problem-resolution.service";
import { problemTimelineService, type TimelineEntry } from "../services/problem-timeline.service";
import { problemsService } from "../services/problems.service";

/**
 * Problem Server Actions. ADR-006 Decision 3: the network boundary.
 *
 * No business logic. Each resolves the caller, calls one service method, and
 * translates a Result into something that survives serialisation. Every
 * authorization and transition decision belongs to the services — an action is
 * a POST endpoint, and hiding a button protects nothing.
 */

export interface ActionFailure {
  readonly ok: false;
  readonly message: string;
  readonly code: string;
  readonly fieldErrors?: Record<string, string> | undefined;
}

export type ActionResult<T> = { readonly ok: true; readonly data: T } | ActionFailure;

function toFailure(error: AppError): ActionFailure {
  return {
    ok: false,
    message: error.userMessage,
    code: error.code,
    fieldErrors: "fieldErrors" in error ? (error.fieldErrors as Record<string, string>) : undefined,
  };
}

async function auditContext(): Promise<AuditContext> {
  const actor = await getCurrentUser();
  const headerList = await headers();

  const forwarded = headerList.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || headerList.get("x-real-ip") || null;
  const agent = headerList.get("user-agent");

  return {
    actor,
    ...(ip ? { ipAddress: ip } : {}),
    ...(agent ? { userAgent: agent } : {}),
  };
}

function revalidateProblem(id?: string): void {
  revalidatePath(ROUTES.PROBLEMS);
  if (id) revalidatePath(`${ROUTES.PROBLEMS}/${id}`);
}

export async function reportProblemAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const context = await auditContext();
  const result = await problemsService.report(input, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidateProblem(result.value.id);
  /* The account and customer screens both show active problems. */
  revalidatePath(ROUTES.ACCOUNTS);
  revalidatePath(ROUTES.CUSTOMERS);

  return { ok: true, data: { id: result.value.id } };
}

export async function updateProblemAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  const context = await auditContext();
  const result = await problemsService.update(id, input, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidateProblem(id);

  return { ok: true, data: { status: result.value.status } };
}

export async function assignProblemAction(
  id: string,
  assignedTo: string | null,
): Promise<ActionResult<{ assignedTo: string | null }>> {
  const context = await auditContext();
  const result = await problemAssignmentService.assign(id, { assignedTo }, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidateProblem(id);

  return { ok: true, data: { assignedTo: result.value.assignedTo } };
}

export async function claimProblemAction(
  id: string,
): Promise<ActionResult<{ assignedTo: string | null }>> {
  const context = await auditContext();
  const result = await problemAssignmentService.claim(id, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidateProblem(id);

  return { ok: true, data: { assignedTo: result.value.assignedTo } };
}

export async function resolveProblemAction(
  id: string,
  resolutionNote: string,
): Promise<ActionResult<{ status: string }>> {
  const context = await auditContext();
  const result = await problemResolutionService.resolve(id, { resolutionNote }, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidateProblem(id);
  revalidatePath(ROUTES.ACCOUNTS);

  return { ok: true, data: { status: result.value.status } };
}

export async function reopenProblemAction(
  id: string,
  reason: string,
): Promise<ActionResult<{ reopenCount: number }>> {
  const context = await auditContext();
  const result = await problemResolutionService.reopen(id, { reason }, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidateProblem(id);
  revalidatePath(ROUTES.ACCOUNTS);

  return { ok: true, data: { reopenCount: result.value.reopenCount } };
}

export async function closeProblemAction(id: string): Promise<ActionResult<{ status: string }>> {
  const context = await auditContext();
  const result = await problemResolutionService.close(id, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidateProblem(id);

  return { ok: true, data: { status: result.value.status } };
}

export async function cancelProblemAction(id: string): Promise<ActionResult<{ status: string }>> {
  const context = await auditContext();
  const result = await problemResolutionService.cancel(id, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidateProblem(id);
  revalidatePath(ROUTES.ACCOUNTS);

  return { ok: true, data: { status: result.value.status } };
}

export async function addProblemNoteAction(
  id: string,
  body: string,
): Promise<ActionResult<TimelineEntry>> {
  const context = await auditContext();
  const result = await problemTimelineService.addNote(id, { body }, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidateProblem(id);

  return { ok: true, data: result.value };
}

export async function deleteProblemAction(id: string): Promise<ActionResult<{ id: string }>> {
  const context = await auditContext();
  const result = await problemsService.remove(id, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidateProblem();
  revalidatePath(ROUTES.ACCOUNTS);

  return { ok: true, data: { id } };
}
