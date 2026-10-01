"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import type { AppError } from "@/lib/errors";
import { jobsService } from "../services/jobs.service";
import type { JobListItem } from "../services/job-view";

/**
 * The jobs page's only write (M08 jobs): withdrawing a queued job.
 *
 * There is deliberately no action to create, claim, retry or finish a job —
 * those belong to server code and workers, never to a browser. The service
 * checks `manage_jobs` before it reads anything.
 */

export type JobActionResult =
  | { readonly ok: true; readonly data: JobListItem }
  | { readonly ok: false; readonly message: string; readonly code: string };

function failure(error: AppError): JobActionResult {
  return { ok: false, message: error.userMessage, code: error.code };
}

export async function cancelJobAction(id: unknown): Promise<JobActionResult> {
  const actor = await getCurrentUser();
  const headerList = await headers();

  const result = await jobsService.cancel(typeof id === "string" ? id : "", {
    actor,
    ipAddress: headerList.get("x-forwarded-for") ?? undefined,
    userAgent: headerList.get("user-agent") ?? undefined,
  });

  if (!result.ok) {
    return failure(result.error);
  }

  revalidatePath(ROUTES.JOBS);

  return { ok: true, data: result.value };
}
