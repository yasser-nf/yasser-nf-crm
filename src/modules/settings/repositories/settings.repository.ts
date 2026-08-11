import { and, desc, eq, sql } from "drizzle-orm";

import { databaseAdapter, requireFound } from "@/lib/database";
import { auditLogs, settings, users, type SettingsRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";
import type { SettingsUpdate } from "../validation/settings.schema";

/**
 * One recorded settings change.
 *
 * Read from `audit_logs` rather than a second history table — every settings
 * write already records before and after there, which is exactly what the
 * change history needs to show.
 */
export interface SettingsChange {
  readonly id: string;
  readonly actorName: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly createdAt: Date;
}

/**
 * Settings repository.
 *
 * 03_DATABASE.md: one row only. The unique index on `singleton` enforces that in
 * the database, so this repository never has to check whether a second row
 * exists — it cannot.
 */

const ENTITY = "Settings";

export interface SettingsRepository {
  /**
   * Reads the settings row, creating it if this is the first call.
   *
   * Idempotent and safe under concurrency: the insert is written with ON
   * CONFLICT DO NOTHING against the singleton index, so two simultaneous callers
   * produce one row and both read it. A read-then-insert would race and one of
   * them would fail.
   */
  ensureExists(): Promise<Result<SettingsRow>>;
  update(input: SettingsUpdate): Promise<Result<SettingsRow>>;
  /** Change history, newest first, from the audit log. */
  history(limit?: number): Promise<Result<readonly SettingsChange[]>>;
}

export const settingsRepository: SettingsRepository = {
  async ensureExists() {
    return databaseAdapter.transaction("settings.ensureExists", async (executor) => {
      await executor.insert(settings).values({ singleton: true }).onConflictDoNothing();

      const rows = await executor
        .select()
        .from(settings)
        .where(eq(settings.singleton, true))
        .limit(1);

      const row = rows[0];

      if (!row) {
        /* Unreachable: the insert above guarantees the row. Throwing rolls back. */
        throw new Error("Settings row missing after upsert");
      }

      return row;
    });
  },

  async update(input) {
    const result = await databaseAdapter.query("settings.update", (executor) =>
      executor
        .update(settings)
        .set({ ...input, updatedAt: sql`now()` })
        .where(eq(settings.singleton, true))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], ENTITY, "singleton");
  },

  async history(limit = 50) {
    return databaseAdapter.query("settings.history", (executor) =>
      executor
        .select({
          id: auditLogs.id,
          actorName: users.name,
          before: auditLogs.before,
          after: auditLogs.after,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.userId))
        .where(and(eq(auditLogs.entity, "settings"), eq(auditLogs.action, "update")))
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit),
    );
  },
};
