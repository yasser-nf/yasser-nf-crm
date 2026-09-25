/**
 * Notifications module — public API. ADR-003 Rule 2.
 *
 * The repository is NOT exported: a caller holding it could write a
 * notification to anyone, or read somebody else's. Other modules notify
 * through `notificationsService.notify` / `notifyOrWarn`; people read their own
 * through the actions behind `NotificationCenter`.
 */
export { notificationsService, type NotifyInput } from "./services/notifications.service";
export {
  NOTIFICATION_TYPES,
  RECENT_NOTIFICATIONS_LIMIT,
  isNotificationType,
  notificationHref,
  type NotificationItem,
  type NotificationSummary,
  type NotificationType,
} from "./services/notification-types";
export { NotificationCenter } from "./components/notification-center";
