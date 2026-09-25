import { ROUTES } from "@/config/constants";

/**
 * What a notification can be about, and where it can lead.
 *
 * Client-safe and pure: the panel, the service and the tests share it.
 *
 * The event list mirrors the `notifications_type_known` check constraint
 * exactly. Every type is a real transition of a problem that already happens
 * in the Problems module (M08); nothing here invents a business event.
 */
export const NOTIFICATION_TYPES = [
  "problem_reported",
  "problem_assigned",
  "problem_resolved",
  "problem_reopened",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** The entities a notification may point at. A closed list, like the routes. */
export const NOTIFICATION_ENTITY_TYPES = ["issue"] as const;

export type NotificationEntityType = (typeof NOTIFICATION_ENTITY_TYPES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The page a notification opens, or null when it points at nothing.
 *
 * Built from a closed map rather than stored: a row can therefore only ever
 * link to a route the application defines, never to a URL someone wrote into
 * the table.
 */
export function notificationHref(
  entityType: string | null,
  entityId: string | null,
): string | null {
  if (entityType === null || entityId === null || !UUID.test(entityId)) {
    return null;
  }

  switch (entityType) {
    case "issue":
      return `${ROUTES.PROBLEMS}/${entityId}`;
    default:
      return null;
  }
}

/** What the panel receives. Dates are ISO strings: it crosses the network. */
export interface NotificationItem {
  readonly id: string;
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string | null;
  readonly href: string | null;
  readonly read: boolean;
  readonly createdAt: string;
}

export interface NotificationSummary {
  readonly items: readonly NotificationItem[];
  readonly unreadCount: number;
}

/** How many the panel shows. The unread COUNT is exact regardless. */
export const RECENT_NOTIFICATIONS_LIMIT = 20;
