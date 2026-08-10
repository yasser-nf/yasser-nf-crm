import { and, desc, eq, sql } from "drizzle-orm";

import {
  databaseAdapter,
  normalizePagination,
  readCount,
  requireFound,
  type Page,
  type PaginationInput,
} from "@/lib/database";
import { auditLogs, loginHistory, type LoginHistoryRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import type { LoginHistoryInsert } from "../validation/user.schema";

/**
 * Activity and login history repository.
 *
 * The M06 brief requires the Activity Feed to stay separate from the Audit Log,
 * and it is — but not by storing anything twice.
 *
 * Audit is entity-centric and already records every business change. Activity
 * is the same rows read along a different axis: filtered by actor rather than
 * by entity. Writing a second copy per action would double every write and
 * create two histories that can disagree.
 *
 * Login history is a genuinely separate table, because a sign-in is not a
 * change to any entity and has nowhere to live in the audit model.
 */

/** One line in a user's activity feed. */
export interface ActivityEntry {
  readonly id: string;
  readonly kind: "audit" | "auth";
  readonly action: string;
  readonly entity: string | null;
  readonly entityId: string | null;
  readonly createdAt: Date;
}

export interface ActivityRepository {
  recordAuthEvent(input: LoginHistoryInsert): Promise<Result<LoginHistoryRow>>;
  loginHistoryForUser(
    userId: string,
    pagination?: PaginationInput,
  ): Promise<Result<Page<LoginHistoryRow>>>;
  /** Business actions and auth events for one person, newest first. */
  activityForUser(userId: string, limit?: number): Promise<Result<readonly ActivityEntry[]>>;
}

export const activityRepository: ActivityRepository = {
  async recordAuthEvent(input) {
    const result = await databaseAdapter.query("activity.recordAuthEvent", (executor) =>
      executor.insert(loginHistory).values(input).returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Login history entry", input.eventType);
  },

  async loginHistoryForUser(userId, pagination = {}) {
    const { limit, offset } = normalizePagination(pagination);
    const where = eq(loginHistory.userId, userId);

    return databaseAdapter.transaction("activity.loginHistoryForUser", async (executor) => {
      const items = await executor
        .select()
        .from(loginHistory)
        .where(where)
        .orderBy(desc(loginHistory.createdAt))
        .limit(limit)
        .offset(offset);

      const totals = await executor
        .select({ count: sql<number>`count(*)::int` })
        .from(loginHistory)
        .where(where);

      return { items, total: readCount(totals), limit, offset };
    });
  },

  /**
   * Merges the two sources into one feed.
   *
   * A UNION in SQL rather than two queries stitched together in JavaScript:
   * ordering across both sources has to happen before the limit, or the feed
   * would show the newest N of each rather than the newest N overall.
   */
  async activityForUser(userId, limit = 50) {
    return databaseAdapter.query("activity.activityForUser", async (executor) => {
      const rows = await executor.execute(sql`
        (
          select
            ${auditLogs.id}        as id,
            'audit'                as kind,
            ${auditLogs.action}::text as action,
            ${auditLogs.entity}::text as entity,
            ${auditLogs.entityId}  as entity_id,
            ${auditLogs.createdAt} as created_at
          from ${auditLogs}
          where ${and(eq(auditLogs.userId, userId))}
        )
        union all
        (
          select
            ${loginHistory.id}        as id,
            'auth'                    as kind,
            ${loginHistory.eventType}::text as action,
            null                      as entity,
            null                      as entity_id,
            ${loginHistory.createdAt} as created_at
          from ${loginHistory}
          where ${and(eq(loginHistory.userId, userId))}
        )
        order by created_at desc
        limit ${limit}
      `);

      return (rows as unknown as Record<string, unknown>[]).map((row): ActivityEntry => ({
        id: String(row["id"]),
        kind: row["kind"] === "auth" ? "auth" : "audit",
        action: String(row["action"]),
        entity: row["entity"] === null ? null : String(row["entity"]),
        entityId: row["entity_id"] === null ? null : String(row["entity_id"]),
        createdAt: new Date(row["created_at"] as string),
      }));
    });
  },
};
