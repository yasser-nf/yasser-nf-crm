import { and, asc, eq } from "drizzle-orm";

import { databaseAdapter, requireFound } from "@/lib/database";
import { reportPresets, type ReportPresetRow } from "@/lib/drizzle/schema";
import type { Result } from "@/types/result";

/**
 * Saved report presets.
 *
 * Every method takes the owner's id and filters by it. Ownership is not a
 * convenience here — a preset belongs to one person, and the RLS policy on the
 * table enforces the same rule independently.
 */

export interface PresetsRepository {
  listFor(userId: string, report?: string): Promise<Result<readonly ReportPresetRow[]>>;
  findOwned(id: string, userId: string): Promise<Result<ReportPresetRow>>;
  save(input: typeof reportPresets.$inferInsert): Promise<Result<ReportPresetRow>>;
  remove(id: string, userId: string): Promise<Result<ReportPresetRow>>;
}

export const presetsRepository: PresetsRepository = {
  async listFor(userId, report) {
    const where = report
      ? and(eq(reportPresets.userId, userId), eq(reportPresets.report, report))
      : eq(reportPresets.userId, userId);

    return databaseAdapter.query("presets.listFor", (executor) =>
      executor.select().from(reportPresets).where(where).orderBy(asc(reportPresets.name)),
    );
  },

  async findOwned(id, userId) {
    const result = await databaseAdapter.query("presets.findOwned", (executor) =>
      executor
        .select()
        .from(reportPresets)
        /* Owner is part of the lookup, so another person's id simply finds nothing. */
        .where(and(eq(reportPresets.id, id), eq(reportPresets.userId, userId)))
        .limit(1),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Preset", id);
  },

  async save(input) {
    const result = await databaseAdapter.query("presets.save", (executor) =>
      executor
        .insert(reportPresets)
        .values(input)
        /*
         * Saving the same name twice updates rather than duplicating. Without
         * this, adjusting a preset means deleting and recreating it, and the
         * unique index would reject the second save outright.
         */
        .onConflictDoUpdate({
          target: [reportPresets.userId, reportPresets.report, reportPresets.name],
          set: {
            filters: input.filters,
            columns: input.columns,
            sort: input.sort,
            exportFormat: input.exportFormat,
            updatedAt: new Date(),
          },
        })
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Preset", "saved");
  },

  async remove(id, userId) {
    const result = await databaseAdapter.query("presets.remove", (executor) =>
      executor
        .delete(reportPresets)
        .where(and(eq(reportPresets.id, id), eq(reportPresets.userId, userId)))
        .returning(),
    );

    if (!result.ok) {
      return result;
    }

    return requireFound(result.value[0], "Preset", id);
  },
};
