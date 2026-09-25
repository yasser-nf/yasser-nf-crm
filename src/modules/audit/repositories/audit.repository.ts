import { and, count, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";

import {
  databaseAdapter,
  normalizePagination,
  readCount,
  requireFound,
  type Page,
  type PaginationInput,
} from "@/lib/database";
import { auditLogs, users, type AuditLogRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import { ok } from "@/utils/result";
import type { AuditLogViewRow, LogsSearchTerms } from "../services/log-view";
import type { AuditLogInsert } from "../validation/audit-log.schema";

/**
 * Audit repository.
 *
 * Append and read. There is no update method and no delete method, and there
 * never should be — 01_MASTER_RULES.md requires the audit log to be immutable.
 *
 * The absence of those methods is the enforcement available at this layer. A
 * database-level guarantee (REVOKE UPDATE, DELETE on the application role, or a
 * rule that raises on either) would be stronger and is recorded as outstanding:
 * it depends on which role the application connects as, which is a Supabase
 * decision not yet made.
 *
 * Callers must strip secrets before writing. `before` and `after` snapshots of an
 * account row would otherwise carry password_encrypted into a table that history
 * views read freely.
 */

const ENTITY = "Audit log";

export interface AuditFilter extends PaginationInput {
  readonly entity?: AuditLogRow["entity"] | undefined;
  readonly entityId?: string | undefined;
  readonly userId?: string | undefined;
  readonly action?: AuditLogRow["action"] | undefined;
}

/**
 * The Logs page's query (M06). Every field is already validated by the service:
 * enums are known values, the date range is a pair of UTC instants, and the
 * search terms are escaped.
 */
export interface LogsQuery extends PaginationInput {
  readonly userId?: string | undefined;
  readonly entity?: AuditLogRow["entity"] | undefined;
  readonly action?: AuditLogRow["action"] | undefined;
  /** Inclusive. */
  readonly start?: Date | undefined;
  /** Exclusive. */
  readonly end?: Date | undefined;
  readonly search?: LogsSearchTerms | null | undefined;
}

export interface AuditRepository {
  record(input: AuditLogInsert): Promise<Result<AuditLogRow>>;
  /**
   * A page of entries with their actor's current name and email, newest first.
   * One query for the rows (actors joined, never looked up per row) and one to
   * count them.
   */
  listForLogs(query: LogsQuery): Promise<Result<Page<AuditLogViewRow>>>;
  /** Names for a set of user ids, in one query. */
  userNames(ids: readonly string[]): Promise<Result<ReadonlyMap<string, string>>>;
  list(filter?: AuditFilter): Promise<Result<Page<AuditLogRow>>>;
  /** Full history for one record, newest first. */
  listForEntity(
    entity: AuditLogRow["entity"],
    entityId: string,
    pagination?: PaginationInput,
  ): Promise<Result<Page<AuditLogRow>>>;
}

function buildFilter(filter: AuditFilter) {
  const conditions = [];

  if (filter.entity !== undefined) {
    conditions.push(eq(auditLogs.entity, filter.entity));
  }

  if (filter.entityId !== undefined) {
    conditions.push(eq(auditLogs.entityId, filter.entityId));
  }

  if (filter.userId !== undefined) {
    conditions.push(eq(auditLogs.userId, filter.userId));
  }

  if (filter.action !== undefined) {
    conditions.push(eq(auditLogs.action, filter.action));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

function buildLogsWhere(query: LogsQuery): SQL | undefined {
  const conditions: (SQL | undefined)[] = [
    query.userId ? eq(auditLogs.userId, query.userId) : undefined,
    query.entity ? eq(auditLogs.entity, query.entity) : undefined,
    query.action ? eq(auditLogs.action, query.action) : undefined,
    query.start ? gte(auditLogs.createdAt, query.start) : undefined,
    query.end ? lt(auditLogs.createdAt, query.end) : undefined,
  ];

  const search = query.search;

  if (search) {
    /*
     * Safe fields only: who acted, which entity, what kind of action or event,
     * and the subject's email. Never notes, descriptions, phone numbers or any
     * other snapshot content — searching a field reveals it one match at a time.
     */
    conditions.push(
      or(
        ilike(users.name, search.contains),
        ilike(users.email, search.contains),
        ilike(auditLogs.actorEmail, search.contains),
        sql`${auditLogs.after} ->> 'email' ilike ${search.contains}`,
        sql`${auditLogs.before} ->> 'email' ilike ${search.contains}`,
        search.idPrefix ? sql`${auditLogs.entityId}::text ilike ${search.idPrefix}` : undefined,
        search.actions.length > 0
          ? inArray(auditLogs.action, [...search.actions] as AuditLogRow["action"][])
          : undefined,
        search.entities.length > 0
          ? inArray(auditLogs.entity, [...search.entities] as AuditLogRow["entity"][])
          : undefined,
        search.events.length > 0
          ? sql`${auditLogs.after} ->> 'event' in (${sql.join(
              search.events.map((event) => sql`${event}`),
              sql`, `,
            )})`
          : undefined,
      ),
    );
  }

  const active = conditions.filter((condition): condition is SQL => condition !== undefined);

  return active.length > 0 ? and(...active) : undefined;
}

export const auditRepository: AuditRepository = {
  async record(input) {
    const result = await databaseAdapter.query("audit.record", (executor) =>
      executor.insert(auditLogs).values(input).returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, input.entityId);
  },

  async list(filter = {}) {
    const { limit, offset } = normalizePagination(filter);
    const where = buildFilter(filter);

    return databaseAdapter.transaction("audit.list", async (executor) => {
      const items = await executor
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit)
        .offset(offset);

      const totals = await executor.select({ count: count() }).from(auditLogs).where(where);

      return { items, total: readCount(totals), limit, offset };
    });
  },

  async listForLogs(query) {
    const { limit, offset } = normalizePagination(query);
    const where = buildLogsWhere(query);

    return databaseAdapter.transaction("audit.listForLogs", async (executor) => {
      const items = await executor
        .select({
          id: auditLogs.id,
          createdAt: auditLogs.createdAt,
          entity: auditLogs.entity,
          entityId: auditLogs.entityId,
          action: auditLogs.action,
          before: auditLogs.before,
          after: auditLogs.after,
          userId: auditLogs.userId,
          actorEmail: auditLogs.actorEmail,
          actorName: users.name,
          actorCurrentEmail: users.email,
          ipAddress: auditLogs.ipAddress,
          userAgent: auditLogs.userAgent,
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.userId))
        .where(where)
        /* Deterministic: equal timestamps (one bulk action) keep a stable order across pages. */
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(limit)
        .offset(offset);

      const totals = await executor
        .select({ count: count() })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.userId))
        .where(where);

      return { items, total: readCount(totals), limit, offset };
    });
  },

  async userNames(ids) {
    if (ids.length === 0) {
      return ok(new Map<string, string>());
    }

    const result = await databaseAdapter.query("audit.userNames", (executor) =>
      executor
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, [...ids])),
    );

    if (!result.ok) {
      return result;
    }

    return ok(new Map(result.value.map((row) => [row.id, row.name])));
  },

  async listForEntity(entity, entityId, pagination = {}) {
    return this.list({ ...pagination, entity, entityId });
  },
};
