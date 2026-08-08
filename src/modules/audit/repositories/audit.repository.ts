import { and, count, desc, eq } from "drizzle-orm";

import {
  databaseAdapter,
  normalizePagination,
  readCount,
  requireFound,
  type Page,
  type PaginationInput,
} from "@/lib/database";
import { auditLogs, type AuditLogRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
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

export interface AuditRepository {
  record(input: AuditLogInsert): Promise<Result<AuditLogRow>>;
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

  async listForEntity(entity, entityId, pagination = {}) {
    return this.list({ ...pagination, entity, entityId });
  },
};
