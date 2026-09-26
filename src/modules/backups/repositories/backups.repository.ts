import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import {
  databaseAdapter,
  normalizePagination,
  readCount,
  requireFound,
  type Page,
  type PaginationInput,
} from "@/lib/database";
import { backups, users, type BackupRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import { tryRestoreLock } from "./dataset.repository";

/**
 * Backup metadata repository.
 *
 * Owns the catalogue, never the artifact. The bytes live in Supabase Storage —
 * see storage/backup-storage.ts.
 */

export interface BackupFilter extends PaginationInput {
  readonly type?: BackupRow["type"] | undefined;
  readonly status?: BackupRow["status"] | undefined;
}

/**
 * A backup with its creator's name resolved.
 *
 * Joined in the query rather than looked up per row: the list shows "Created
 * By" for every entry, and a lookup per row is the N+1 the architecture forbids.
 * Null for scheduled backups, which no person triggers.
 */
export interface BackupListEntry {
  readonly backup: BackupRow;
  readonly createdByName: string | null;
}

export interface BackupsRepository {
  list(filter?: BackupFilter): Promise<Result<Page<BackupListEntry>>>;
  findById(id: string): Promise<Result<BackupRow>>;
  create(input: typeof backups.$inferInsert): Promise<Result<BackupRow>>;
  markCompleted(
    id: string,
    patch: {
      filename: string;
      checksum: string;
      sizeBytes: number;
      tableCounts: Record<string, number>;
      appVersion: string;
      databaseVersion: string;
    },
  ): Promise<Result<BackupRow>>;
  markFailed(id: string, reason: string): Promise<Result<BackupRow>>;
  markVerified(id: string): Promise<Result<BackupRow>>;
  /** Everything a retention decision needs, without loading whole rows. */
  retentionCandidates(): Promise<
    Result<readonly { id: string; createdAt: Date; type: string; isRestorePoint: boolean }[]>
  >;
  /**
   * Deletes backup rows — but only while no restore is running (M07). Takes
   * the restore advisory lock inside its own transaction; if a restore holds
   * it, nothing is deleted and `null` is returned.
   */
  deleteMany(ids: readonly string[]): Promise<Result<readonly BackupRow[] | null>>;
  /** Protects a backup from retention for good: it was restored from, or deliberately kept. */
  markRestorePoint(id: string): Promise<Result<BackupRow>>;
  /** Backups whose status is still `running`, oldest first. */
  running(): Promise<Result<readonly BackupRow[]>>;
  /** Marks `running` rows started before `startedBefore` as failed: their process is gone. */
  failInterrupted(startedBefore: Date, reason: string): Promise<Result<number>>;
  /** The newest successful backup of one of these types, or null. */
  lastSuccessful(types?: readonly BackupRow["type"][]): Promise<Result<BackupRow | null>>;
  /** The newest failed backup, or null. */
  lastFailed(): Promise<Result<BackupRow | null>>;
  /** Successful backups, and all backups, in the catalogue. */
  counts(): Promise<Result<{ readonly successful: number; readonly total: number }>>;
}

const SUCCESSFUL: BackupRow["status"][] = ["completed", "verified"];

export const backupsRepository: BackupsRepository = {
  async list(filter = {}) {
    const { limit, offset } = normalizePagination(filter);

    const conditions = [
      filter.type ? eq(backups.type, filter.type) : undefined,
      filter.status ? eq(backups.status, filter.status) : undefined,
    ].filter((condition) => condition !== undefined);

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return databaseAdapter.transaction("backups.list", async (executor) => {
      const rows = await executor
        .select({ backup: backups, createdByName: users.name })
        .from(backups)
        .leftJoin(users, eq(users.id, backups.createdBy))
        .where(where)
        .orderBy(desc(backups.createdAt))
        .limit(limit)
        .offset(offset);

      const totals = await executor
        .select({ count: sql<number>`count(*)::int` })
        .from(backups)
        .where(where);

      return { items: rows, total: readCount(totals), limit, offset };
    });
  },

  async findById(id) {
    const result = await databaseAdapter.query("backups.findById", (executor) =>
      executor.select().from(backups).where(eq(backups.id, id)).limit(1),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Backup", id);
  },

  async create(input) {
    const result = await databaseAdapter.query("backups.create", (executor) =>
      executor.insert(backups).values(input).returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Backup", "created");
  },

  async markCompleted(id, patch) {
    const result = await databaseAdapter.query("backups.markCompleted", (executor) =>
      executor
        .update(backups)
        .set({
          status: "completed",
          filename: patch.filename,
          checksum: patch.checksum,
          sizeBytes: patch.sizeBytes,
          tableCounts: patch.tableCounts,
          appVersion: patch.appVersion,
          databaseVersion: patch.databaseVersion,
          completedAt: new Date(),
        })
        .where(eq(backups.id, id))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Backup", id);
  },

  async markFailed(id, reason) {
    const result = await databaseAdapter.query("backups.markFailed", (executor) =>
      executor
        .update(backups)
        /* The table's check constraint requires a reason on every failure. */
        .set({ status: "failed", errorMessage: reason.slice(0, 2000) })
        .where(eq(backups.id, id))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Backup", id);
  },

  async markVerified(id) {
    const result = await databaseAdapter.query("backups.markVerified", (executor) =>
      executor
        .update(backups)
        .set({ status: "verified", verifiedAt: new Date() })
        .where(eq(backups.id, id))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Backup", id);
  },

  async retentionCandidates() {
    return databaseAdapter.query("backups.retentionCandidates", async (executor) => {
      const rows = await executor
        .select({
          id: backups.id,
          createdAt: backups.createdAt,
          type: backups.type,
          isRestorePoint: backups.isRestorePoint,
        })
        .from(backups)
        /*
         * Only finished backups compete for retention slots. A failed row has no
         * artifact, and counting it would let failures evict good backups.
         */
        .where(inArray(backups.status, ["completed", "verified"]))
        .orderBy(desc(backups.createdAt));

      return rows;
    });
  },

  async deleteMany(ids) {
    if (ids.length === 0) {
      return databaseAdapter.query("backups.deleteMany", async () => []);
    }

    return databaseAdapter.transaction("backups.deleteMany", async (executor) => {
      /* A restore in progress may be reading any of these: do not touch them. */
      if (!(await tryRestoreLock(executor))) {
        return null;
      }

      return executor
        .delete(backups)
        .where(inArray(backups.id, [...ids]))
        .returning();
    });
  },

  async markRestorePoint(id) {
    const result = await databaseAdapter.query("backups.markRestorePoint", (executor) =>
      executor.update(backups).set({ isRestorePoint: true }).where(eq(backups.id, id)).returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Backup", id);
  },

  async running() {
    return databaseAdapter.query("backups.running", (executor) =>
      executor
        .select()
        .from(backups)
        .where(eq(backups.status, "running"))
        .orderBy(backups.createdAt, backups.id),
    );
  },

  async failInterrupted(startedBefore, reason) {
    const result = await databaseAdapter.query("backups.failInterrupted", (executor) =>
      executor
        .update(backups)
        .set({ status: "failed", errorMessage: reason })
        .where(and(eq(backups.status, "running"), lt(backups.createdAt, startedBefore)))
        .returning({ id: backups.id }),
    );

    if (!result.ok) {
      return result;
    }

    return { ok: true, value: result.value.length } as const;
  },

  async lastSuccessful(types) {
    const result = await databaseAdapter.query("backups.lastSuccessful", (executor) =>
      executor
        .select()
        .from(backups)
        .where(
          and(
            inArray(backups.status, SUCCESSFUL),
            types && types.length > 0 ? inArray(backups.type, [...types]) : undefined,
          ),
        )
        .orderBy(desc(backups.createdAt))
        .limit(1),
    );

    if (!result.ok) {
      return result;
    }

    return { ok: true, value: result.value[0] ?? null } as const;
  },

  async lastFailed() {
    const result = await databaseAdapter.query("backups.lastFailed", (executor) =>
      executor
        .select()
        .from(backups)
        .where(eq(backups.status, "failed"))
        .orderBy(desc(backups.createdAt))
        .limit(1),
    );

    if (!result.ok) {
      return result;
    }

    return { ok: true, value: result.value[0] ?? null } as const;
  },

  async counts() {
    return databaseAdapter.query("backups.counts", async (executor) => {
      const [row] = await executor
        .select({
          successful: sql<number>`count(*) filter (where ${inArray(backups.status, SUCCESSFUL)})::int`,
          total: sql<number>`count(*)::int`,
        })
        .from(backups);

      return { successful: row?.successful ?? 0, total: row?.total ?? 0 };
    });
  },
};
