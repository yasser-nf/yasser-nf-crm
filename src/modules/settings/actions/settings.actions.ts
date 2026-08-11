"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import type { AppError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import { settingsService } from "../services/settings.service";
import type { SettingsCategory } from "../services/settings-definitions";

/**
 * Settings Server Actions. ADR-006 Decision 3: the network boundary.
 *
 * No business logic and no validation of their own — the service validates,
 * checks the cross-field rules, authorizes and audits. An action that
 * pre-validated would create a second set of rules to keep in step.
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

export async function updateSettingsAction(
  category: SettingsCategory,
  values: unknown,
): Promise<ActionResult<{ category: SettingsCategory }>> {
  const context = await auditContext();
  const result = await settingsService.updateCategory(category, values, context);

  if (!result.ok) {
    return toFailure(result.error);
  }

  revalidatePath(ROUTES.SETTINGS);
  revalidatePath(`${ROUTES.SETTINGS}/${category}`);

  /*
   * Backup retention and the schedule are read by the backups screens, and the
   * application name appears in the shell on every page.
   */
  if (category === "backups") {
    revalidatePath(ROUTES.BACKUPS);
  }

  return { ok: true, data: { category } };
}
