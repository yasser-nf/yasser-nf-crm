import "server-only";

import { z } from "zod";

import type { AppUser } from "@/lib/auth";
import { UnauthorizedError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import {
  notificationsRepository,
  type NewNotification,
  type NotificationRecipients,
} from "../repositories/notifications.repository";
import {
  RECENT_NOTIFICATIONS_LIMIT,
  isNotificationType,
  notificationHref,
  type NotificationEntityType,
  type NotificationItem,
  type NotificationSummary,
  type NotificationType,
} from "./notification-types";

/**
 * Notifications service.
 *
 * Two surfaces with different callers, kept apart on purpose:
 *
 *   notify / notifyOrWarn   called by OTHER SERVICES after a real state change.
 *                           There is no action for it: a browser cannot create
 *                           a notification, trusted or otherwise.
 *
 *   summary / markRead /    called by the signed-in person, through actions.
 *   markAllRead             Always about their own notifications — the actor's
 *                           id is the scope of every query, so there is no
 *                           other person's row to reach and no permission to
 *                           check beyond being signed in.
 */

export interface NotifyInput {
  readonly type: NotificationType;
  readonly recipients: NotificationRecipients;
  /** The person whose action this is. They are never notified of it. */
  readonly actor: AppUser | null;
  readonly title: string;
  readonly body?: string | null;
  readonly entity?: { readonly type: NotificationEntityType; readonly id: string } | null;
  /** Identifies the event; the same key twice for one person is one notification. */
  readonly dedupeKey: string;
}

/** Longest title or body stored. A notification is a line, not a document. */
const MAX_TEXT = 300;

function clip(text: string): string {
  const trimmed = text.trim();

  return trimmed.length <= MAX_TEXT ? trimmed : `${trimmed.slice(0, MAX_TEXT - 1)}…`;
}

async function notify(input: NotifyInput): Promise<Result<number>> {
  const title = clip(input.title);

  if (title.length === 0 || input.dedupeKey.trim().length === 0) {
    return fail(new ValidationError("A notification needs a title and an event key"));
  }

  const row: NewNotification = {
    recipients: input.recipients,
    excludeUserId: input.actor?.id ?? null,
    actorId: input.actor?.id ?? null,
    type: input.type,
    title,
    body: input.body ? clip(input.body) : null,
    entityType: input.entity?.type ?? null,
    entityId: input.entity?.id ?? null,
    dedupeKey: input.dedupeKey,
  };

  return notificationsRepository.insert(row);
}

/**
 * Notifies, and never fails the operation that caused it.
 *
 * The same contract as `auditService.recordOrWarn`: the problem WAS resolved,
 * and a notification that could not be written must not turn that into an
 * error for the person who resolved it. The failure is logged — with the
 * event, never the text — so it is visible rather than silent.
 */
async function notifyOrWarn(input: NotifyInput): Promise<void> {
  const result = await notify(input);

  if (!result.ok) {
    logger.error("Notification could not be written", result.error, {
      type: input.type,
      entityId: input.entity?.id,
    });
  }
}

/** Removes the notices about an entity that no longer exists, so none links to nothing. */
async function removeForEntity(
  entityType: NotificationEntityType,
  entityId: string,
): Promise<Result<number>> {
  return notificationsRepository.removeForEntity(entityType, entityId);
}

function requireActor(actor: AppUser | null, action: string): Result<AppUser> {
  return actor ? ok(actor) : fail(new UnauthorizedError(`No signed-in user to ${action}`));
}

/**
 * The panel and the badge: the newest notifications and the exact unread count.
 *
 * Both reads must succeed. A count that failed is not zero, and a list that
 * failed is not "no notifications" — the caller receives the failure and says
 * so, rather than rendering an empty panel over an outage.
 */
async function summary(actor: AppUser | null): Promise<Result<NotificationSummary>> {
  const permitted = requireActor(actor, "read notifications");

  if (!permitted.ok) {
    return permitted;
  }

  const [rows, unread] = await Promise.all([
    notificationsRepository.listRecent(permitted.value.id, RECENT_NOTIFICATIONS_LIMIT),
    notificationsRepository.unreadCount(permitted.value.id),
  ]);

  if (!rows.ok) {
    return rows;
  }

  if (!unread.ok) {
    return unread;
  }

  const items: NotificationItem[] = rows.value.flatMap((row) =>
    /* A type the constraint allows but this build does not know is skipped, not guessed. */
    isNotificationType(row.type)
      ? [
          {
            id: row.id,
            type: row.type,
            title: row.title,
            body: row.body,
            href: notificationHref(row.entityType, row.entityId),
            read: row.readAt !== null,
            createdAt: row.createdAt.toISOString(),
          },
        ]
      : [],
  );

  return ok({ items, unreadCount: unread.value });
}

const idSchema = z.uuid();

async function markRead(id: unknown, actor: AppUser | null): Promise<Result<boolean>> {
  const permitted = requireActor(actor, "mark a notification read");

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = idSchema.safeParse(id);

  if (!parsed.success) {
    return fail(new ValidationError("Notification id is not valid"));
  }

  return notificationsRepository.markRead(permitted.value.id, parsed.data);
}

async function markAllRead(actor: AppUser | null): Promise<Result<number>> {
  const permitted = requireActor(actor, "mark notifications read");

  if (!permitted.ok) {
    return permitted;
  }

  return notificationsRepository.markAllRead(permitted.value.id);
}

export const notificationsService = {
  notify,
  notifyOrWarn,
  removeForEntity,
  summary,
  markRead,
  markAllRead,
} as const;
