import { and, count, desc, eq, sql } from "drizzle-orm";

import {
  databaseAdapter,
  normalizePagination,
  readCount,
  requireFound,
  type Page,
  type PaginationInput,
} from "@/lib/database";
import { backups, type BackupRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import type { BackupInsert, BackupUpdate } from "../validation/backup.schema";

/**
 * Backups repository.
 *
 * Metadata only. The backup artefact lives in object storage; these rows point
 * at it and record whether it has been verified.
 *
 * The lifecycle timestamps are set here rather than by callers, so a row cannot
 * claim to be completed without recording when. 01_MASTER_RULES.md requires
 * backups to be verifiable, and a completion time nobody wrote is not evidence.
 */

const ENTITY = "Backup";

export interface BackupFilter extends PaginationInput {
  readonly type?: BackupRow["type"] | undefined;
  readonly status?: BackupRow["status"] | undefined;
  readonly restorePointsOnly?: boolean | undefined;
}

export interface BackupsRepository {
  findById(id: string): Promise<Result<BackupRow>>;
  list(filter?: BackupFilter): Promise<Result<Page<BackupRow>>>;
  create(input: BackupInsert): Promise<Result<BackupRow>>;
  update(id: string, input: BackupUpdate): Promise<Result<BackupRow>>;
  markCompleted(
    id: string,
    artifact: { filename: string; checksum: string; sizeBytes: number },
  ): Promise<Result<BackupRow>>;
  markVerified(id: string): Promise<Result<BackupRow>>;
  markFailed(id: string, errorMessage: string): Promise<Result<BackupRow>>;
}

function buildFilter(filter: BackupFilter) {
  const conditions = [];

  if (filter.type !== undefined) {
    conditions.push(eq(backups.type, filter.type));
  }

  if (filter.status !== undefined) {
    conditions.push(eq(backups.status, filter.status));
  }

  if (filter.restorePointsOnly === true) {
    conditions.push(eq(backups.isRestorePoint, true));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

export const backupsRepository: BackupsRepository = {
  async findById(id) {
    const result = await databaseAdapter.query("backups.findById", (executor) =>
      executor.select().from(backups).where(eq(backups.id, id)).limit(1),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  async list(filter = {}) {
    const { limit, offset } = normalizePagination(filter);
    const where = buildFilter(filter);

    return databaseAdapter.transaction("backups.list", async (executor) => {
      const items = await executor
        .select()
        .from(backups)
        .where(where)
        .orderBy(desc(backups.createdAt))
        .limit(limit)
        .offset(offset);

      const totals = await executor.select({ count: count() }).from(backups).where(where);

      return { items, total: readCount(totals), limit, offset };
    });
  },

  async create(input) {
    const result = await databaseAdapter.query("backups.create", (executor) =>
      executor.insert(backups).values(input).returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, input.type);
  },

  async update(id, input) {
    const result = await databaseAdapter.query("backups.update", (executor) =>
      executor.update(backups).set(input).where(eq(backups.id, id)).returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  async markCompleted(id, artifact) {
    const result = await databaseAdapter.query("backups.markCompleted", (executor) =>
      executor
        .update(backups)
        .set({ ...artifact, status: "completed", completedAt: sql`now()` })
        .where(eq(backups.id, id))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  /**
   * Records that the checksum was confirmed.
   *
   * Deliberately separate from completion. A backup that finished writing is not
   * yet known to be restorable, and collapsing the two is how organisations
   * discover their backups are empty during a restore.
   */
  async markVerified(id) {
    const result = await databaseAdapter.query("backups.markVerified", (executor) =>
      executor
        .update(backups)
        .set({ status: "verified", verifiedAt: sql`now()` })
        .where(eq(backups.id, id))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },

  async markFailed(id, errorMessage) {
    const result = await databaseAdapter.query("backups.markFailed", (executor) =>
      executor
        .update(backups)
        .set({ status: "failed", errorMessage })
        .where(eq(backups.id, id))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, id);
  },
};
