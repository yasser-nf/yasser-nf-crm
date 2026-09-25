"use server";

import { getCurrentUser } from "@/lib/auth/session";
import type { AppError } from "@/lib/errors";
import { notificationsService } from "../services/notifications.service";
import type { NotificationSummary } from "../services/notification-types";

/**
 * Notification Server Actions. ADR-006 Decision 3: the network boundary.
 *
 * Each resolves the caller on the server and passes them to the service, which
 * scopes every query to that caller. Nothing the browser sends can name a
 * recipient: there is no parameter for one. And there is deliberately no action
 * that creates a notification — only services do that, after a real change.
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

export async function getNotificationsAction(): Promise<ActionResult<NotificationSummary>> {
  const result = await notificationsService.summary(await getCurrentUser());

  return result.ok ? { ok: true, data: result.value } : toFailure(result.error);
}

export async function markNotificationReadAction(id: string): Promise<ActionResult<boolean>> {
  const result = await notificationsService.markRead(id, await getCurrentUser());

  return result.ok ? { ok: true, data: result.value } : toFailure(result.error);
}

export async function markAllNotificationsReadAction(): Promise<ActionResult<number>> {
  const result = await notificationsService.markAllRead(await getCurrentUser());

  return result.ok ? { ok: true, data: result.value } : toFailure(result.error);
}
