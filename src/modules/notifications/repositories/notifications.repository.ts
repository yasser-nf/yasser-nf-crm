import { and, count, desc, eq, isNull, sql } from "drizzle-orm";

import { databaseAdapter } from "@/lib/database";
import { notifications, users, type NotificationRow } from "@/lib/drizzle/schema";
import { NotFoundError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";

/**
 * Notifications repository.
 *
 * Every read and every write that a signed-in person can trigger is scoped by
 * `recipient_id` IN THE QUERY. Ownership is not checked after loading a row —
 * a row that is not yours is never loaded, so there is nothing to leak and no
 * check to forget. The only unscoped statements are the server-side insert
 * (whose recipients the server chooses) and the cleanup when an entity is
 * removed; neither is reachable from a browser.
 */

export type NotificationType = NotificationRow["type"];

/** Who a notification goes to. Resolved to live, active users inside the insert. */
export type NotificationRecipients =
  { readonly userIds: readonly string[] } | { readonly role: "super_admin" };

export interface NewNotification {
  readonly recipients: NotificationRecipients;
  /** Never notified of their own action. */
  readonly excludeUserId: string | null;
  readonly actorId: string | null;
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly dedupeKey: string;
}

/** The columns the panel shows. Selected explicitly, never `select *`. */
export type NotificationListRow = Pick<
  NotificationRow,
  "id" | "type" | "title" | "body" | "entityType" | "entityId" | "readAt" | "createdAt"
>;

export interface NotificationsRepository {
  /** Inserts one notification per recipient; returns how many were new. */
  insert(input: NewNotification): Promise<Result<number>>;
  listRecent(recipientId: string, limit: number): Promise<Result<NotificationListRow[]>>;
  unreadCount(recipientId: string): Promise<Result<number>>;
  /** True when this call marked it; false when it was already read. */
  markRead(recipientId: string, id: string): Promise<Result<boolean>>;
  markAllRead(recipientId: string): Promise<Result<number>>;
  removeForEntity(entityType: string, entityId: string): Promise<Result<number>>;
}

export const notificationsRepository: NotificationsRepository = {
  async insert(input) {
    const audience =
      "role" in input.recipients
        ? sql`u.role = ${input.recipients.role}`
        : input.recipients.userIds.length > 0
          ? sql`u.id in (${sql.join(
              input.recipients.userIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : undefined;

    if (audience === undefined) {
      return ok(0);
    }

    const excluded =
      input.excludeUserId === null ? sql`true` : sql`u.id <> ${input.excludeUserId}::uuid`;

    /*
     * One statement: recipients are chosen from `users` in the same query, so a
     * suspended, disabled or archived user is never notified, and the unique
     * (recipient_id, dedupe_key) index turns a repeat of the same event into a
     * no-op rather than a second row.
     */
    const result = await databaseAdapter.query("notifications.insert", async (executor) => {
      const rows = await executor.execute<{ id: string }>(sql`
        insert into ${notifications}
          (recipient_id, actor_id, type, title, body, entity_type, entity_id, dedupe_key)
        select u.id, ${input.actorId}::uuid, ${input.type}, ${input.title}, ${input.body},
               ${input.entityType}, ${input.entityId}::uuid, ${input.dedupeKey}
        from ${users} u
        where ${audience}
          and ${excluded}
          and u.status = 'active'
          and u.deleted_at is null
        on conflict (recipient_id, dedupe_key) do nothing
        returning id`);

      return rows.length;
    });

    return result;
  },

  async listRecent(recipientId, limit) {
    return databaseAdapter.query("notifications.listRecent", (executor) =>
      executor
        .select({
          id: notifications.id,
          type: notifications.type,
          title: notifications.title,
          body: notifications.body,
          entityType: notifications.entityType,
          entityId: notifications.entityId,
          readAt: notifications.readAt,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .where(eq(notifications.recipientId, recipientId))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(limit),
    );
  },

  async unreadCount(recipientId) {
    const result = await databaseAdapter.query("notifications.unreadCount", (executor) =>
      executor
        .select({ count: count() })
        .from(notifications)
        .where(and(eq(notifications.recipientId, recipientId), isNull(notifications.readAt))),
    );

    if (!result.ok) {
      return result;
    }

    return ok(Number(result.value[0]?.count ?? 0));
  },

  async markRead(recipientId, id) {
    const result = await databaseAdapter.query("notifications.markRead", async (executor) => {
      const marked = await executor
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.recipientId, recipientId),
            isNull(notifications.readAt),
          ),
        )
        .returning({ id: notifications.id });

      if (marked.length > 0) {
        return "marked" as const;
      }

      /* Already read, or not this person's — which must look like "not found". */
      const own = await executor
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.id, id), eq(notifications.recipientId, recipientId)))
        .limit(1);

      return own.length > 0 ? ("already_read" as const) : ("missing" as const);
    });

    if (!result.ok) {
      return result;
    }

    if (result.value === "missing") {
      return fail(
        new NotFoundError(`Notification ${id} not found for its caller`, {
          userMessage: "That notification no longer exists.",
        }),
      );
    }

    return ok(result.value === "marked");
  },

  async markAllRead(recipientId) {
    const result = await databaseAdapter.query("notifications.markAllRead", (executor) =>
      executor
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.recipientId, recipientId), isNull(notifications.readAt)))
        .returning({ id: notifications.id }),
    );

    if (!result.ok) {
      return result;
    }

    return ok(result.value.length);
  },

  async removeForEntity(entityType, entityId) {
    const result = await databaseAdapter.query("notifications.removeForEntity", (executor) =>
      executor
        .delete(notifications)
        .where(and(eq(notifications.entityType, entityType), eq(notifications.entityId, entityId)))
        .returning({ id: notifications.id }),
    );

    if (!result.ok) {
      return result;
    }

    return ok(result.value.length);
  },
};
