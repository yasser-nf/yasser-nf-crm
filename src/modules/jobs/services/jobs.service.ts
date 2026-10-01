import "server-only";

import { PERMISSIONS, roleHasPermission, type Permission } from "@/config/roles";
import type { Page } from "@/lib/database";
import type { AppUser } from "@/lib/auth";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { auditService, type AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { jobsRepository } from "../repositories/jobs.repository";
import {
  invertedRange,
  toJobListItem,
  toRepositoryFilter,
  type JobListItem,
  type JobsFilterInput,
} from "./job-view";

/**
 * The jobs page (M08 jobs): Super Admins see the queue and may withdraw a job
 * that has not started. Every call checks the permission on the server before
 * it reads anything, and returns `JobListItem` — never a raw row.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requirePermission(
  actor: AppUser | null,
  permission: Permission,
  what: string,
): Result<AppUser> {
  if (!actor || !roleHasPermission(actor.role, permission)) {
    return fail(
      new ForbiddenError(`Not permitted to ${what}`, {
        userMessage: "Jobs are restricted to Super Admins.",
      }),
    );
  }

  return ok(actor);
}

async function list(
  filter: JobsFilterInput,
  actor: AppUser | null,
  now = new Date(),
): Promise<Result<Page<JobListItem>>> {
  const permitted = requirePermission(actor, PERMISSIONS.VIEW_JOBS, "view jobs");

  if (!permitted.ok) {
    return permitted;
  }

  if (invertedRange(filter)) {
    return fail(
      new ValidationError("Inverted date range", {
        userMessage: "The start date is after the end date.",
        fieldErrors: { from: "Must not be after the end date" },
      }),
    );
  }

  const page = await jobsRepository.list(toRepositoryFilter(filter));

  if (!page.ok) {
    return page;
  }

  return ok({ ...page.value, items: page.value.items.map((job) => toJobListItem(job, now)) });
}

/** The job types present, for the filter. */
async function types(actor: AppUser | null): Promise<Result<readonly string[]>> {
  const permitted = requirePermission(actor, PERMISSIONS.VIEW_JOBS, "view jobs");
  return permitted.ok ? jobsRepository.types() : permitted;
}

async function getDetail(
  id: string,
  actor: AppUser | null,
  now = new Date(),
): Promise<Result<JobListItem>> {
  const permitted = requirePermission(actor, PERMISSIONS.VIEW_JOBS, "view jobs");

  if (!permitted.ok) {
    return permitted;
  }

  if (!UUID.test(id)) {
    return fail(new NotFoundError("Job not found"));
  }

  const row = await jobsRepository.findById(id);

  if (!row.ok) {
    return row;
  }

  return row.value ? ok(toJobListItem(row.value, now)) : fail(new NotFoundError("Job not found"));
}

/**
 * Withdraws a job that has not started. Only `queued → cancelled`: a running
 * job may already have done its work, and calling it cancelled would be a lie
 * — so it is refused, with the reason.
 */
async function cancel(id: string, context: AuditContext): Promise<Result<JobListItem>> {
  const permitted = requirePermission(context.actor, PERMISSIONS.MANAGE_JOBS, "cancel jobs");

  if (!permitted.ok) {
    return permitted;
  }

  if (!UUID.test(id)) {
    return fail(new NotFoundError("Job not found"));
  }

  const cancelled = await jobsRepository.cancelQueued(id);

  if (!cancelled.ok) {
    return cancelled;
  }

  if (!cancelled.value) {
    const current = await jobsRepository.findById(id);

    if (!current.ok) {
      return current;
    }

    if (!current.value) {
      return fail(new NotFoundError("Job not found"));
    }

    return fail(
      new ConflictError(`Job is ${current.value.status}, not queued`, {
        userMessage:
          current.value.status === "running"
            ? "A running job cannot be cancelled — its work may already have happened. Wait for it to finish."
            : "This job has already finished.",
      }),
    );
  }

  const job = cancelled.value;

  await auditService.recordOrWarn(
    {
      entity: "job",
      entityId: job.id,
      action: "update",
      after: {
        event: "job_cancelled",
        id: job.id,
        type: job.type,
        status: job.status,
        attempts: job.attempts,
        cancelledAt: job.cancelledAt,
      },
    },
    context,
  );

  return ok(toJobListItem(job, new Date()));
}

export const jobsService = { list, types, getDetail, cancel } as const;
