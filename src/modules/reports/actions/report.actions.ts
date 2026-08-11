"use server";

import { revalidatePath } from "next/cache";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import type { AppError } from "@/lib/errors";
import { reportsService } from "../services/reports.service";

/**
 * Preset Server Actions. ADR-006 Decision 3: the network boundary.
 *
 * Only presets go through actions. Exports use a Route Handler because they
 * stream — ADR-011 Decision 3 — and running a report is a page read, not a
 * mutation, so it needs no action at all.
 */

export interface ActionFailure {
  readonly ok: false;
  readonly message: string;
  readonly code: string;
}

export type ActionResult<T> = { readonly ok: true; readonly data: T } | ActionFailure;

function toFailure(error: AppError): ActionFailure {
  return { ok: false, message: error.userMessage, code: error.code };
}

export async function savePresetAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const actor = await getCurrentUser();
  const result = await reportsService.savePreset(input, actor);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidatePath(`${ROUTES.REPORTS}/${result.value.report}`);

  return { ok: true, data: { id: result.value.id } };
}

export async function deletePresetAction(id: string): Promise<ActionResult<{ id: string }>> {
  const actor = await getCurrentUser();
  const result = await reportsService.deletePreset(id, actor);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidatePath(ROUTES.REPORTS);

  return { ok: true, data: { id } };
}
