import "server-only";

import { roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import type { ReportPresetRow } from "@/lib/drizzle/schema";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { presetsRepository } from "../repositories/presets.repository";
import {
  reportsRepository,
  type ReportRow,
  type ReportSummary,
} from "../repositories/reports.repository";
import {
  definitionFor,
  reportsFor,
  type ReportDefinition,
  type ReportKey,
} from "./report-definitions";
import { savePresetSchema, type ReportFilters } from "../validation/report.schema";

/**
 * Reports service.
 *
 * Owns two things: which reports a caller may run, and assembling a report's
 * summary and rows. It computes no business rules of its own — the health
 * report reuses `assessHealth` from M09, and every figure comes from aggregate
 * SQL rather than from rows pulled into JavaScript.
 *
 * Authorization is declarative. Each report names the permission it needs in
 * `report-definitions.ts`, and this service checks that one field. There is no
 * second list of who may see what, because a second list is a list that
 * disagrees.
 */

/** Preview rows shown on screen. Exports stream and are not bounded by this. */
export const PREVIEW_PAGE_SIZE = 50;

export interface ReportPayload {
  readonly definition: ReportDefinition;
  readonly summary: ReportSummary;
  readonly rows: readonly ReportRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

function requireReportAccess(actor: AppUser | null, definition: ReportDefinition): Result<AppUser> {
  if (!actor) {
    return fail(
      new ForbiddenError(`No signed-in user for the ${definition.key} report`, {
        userMessage: "Sign in to run reports.",
      }),
    );
  }

  if (definition.permission && !roleHasPermission(actor.role, definition.permission)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not run the ${definition.key} report`, {
        userMessage: "This report is not available to your role.",
        context: { actorId: actor.id, role: actor.role, report: definition.key },
      }),
    );
  }

  return ok(actor);
}

/** The catalogue, filtered to what this caller may actually run. */
function catalogue(actor: AppUser | null): readonly ReportDefinition[] {
  if (!actor) {
    return [];
  }

  return reportsFor((permission) => roleHasPermission(actor.role, permission));
}

/**
 * The System Health report.
 *
 * Its rows are health findings, not table rows. Composed here from
 * `assessHealth` — the M09 rule — rather than restated in SQL, so the report
 * and the dashboard light can never disagree about what "red" means.
 */
async function healthRows(actor: AppUser): Promise<{ summary: ReportSummary; rows: ReportRow[] }> {
  const { dashboardService } = await import("@/modules/dashboard");
  const dashboard = await dashboardService.load(actor);

  /* "error": the backup facts health depends on could not be read (M04). */
  if (!dashboard.ok || !dashboard.value.health || dashboard.value.health === "error") {
    return {
      summary: { overall: "unknown" },
      rows: [{ check: "System health", level: "unknown", detail: "Health could not be read." }],
    };
  }

  const { health, counts, backups } = dashboard.value;

  return {
    summary: {
      overall: health.level,
      criticalProblems: counts.problems.critical,
      failedBackups: backups && backups !== "error" ? backups.failed : 0,
      activeUsers: counts.users.active,
    },
    rows: health.findings.map((finding) => ({
      check: finding.level === "green" ? "All checks" : "Attention",
      level: finding.level,
      detail: finding.message,
    })),
  };
}

/** Summary plus the first page of rows. */
async function run(
  key: ReportKey,
  filters: ReportFilters,
  actor: AppUser | null,
  page: { limit?: number; offset?: number } = {},
): Promise<Result<ReportPayload>> {
  const definition = definitionFor(key);
  const permitted = requireReportAccess(actor, definition);

  if (!permitted.ok) {
    return permitted;
  }

  const limit = Math.min(Math.max(page.limit ?? PREVIEW_PAGE_SIZE, 1), 200);
  const offset = Math.max(page.offset ?? 0, 0);

  if (key === "system-health") {
    const health = await healthRows(permitted.value);

    return ok({
      definition,
      summary: health.summary,
      rows: health.rows,
      total: health.rows.length,
      limit,
      offset: 0,
    });
  }

  /* Summary, rows and count are independent — awaiting them in sequence would
   * make the page as slow as their sum. */
  const [summary, rows, total] = await Promise.all([
    reportsRepository.summary(key, filters),
    reportsRepository.datasetPage(key, filters, limit, offset),
    reportsRepository.datasetCount(key, filters),
  ]);

  if (!summary.ok) return summary;
  if (!rows.ok) return rows;
  if (!total.ok) return total;

  return ok({
    definition,
    summary: summary.value,
    rows: rows.value,
    total: total.value,
    limit,
    offset,
  });
}

/**
 * One page of rows, for the export stream.
 *
 * Separate from `run` because an export needs neither the summary nor the total
 * — it needs rows, repeatedly, until they run out. Re-checks permission on every
 * page: the export route calls this in a loop, and a check performed once at
 * the start is a check that cannot notice a revoked session.
 */
async function datasetPage(
  key: ReportKey,
  filters: ReportFilters,
  actor: AppUser | null,
  limit: number,
  offset: number,
): Promise<Result<readonly ReportRow[]>> {
  const definition = definitionFor(key);
  const permitted = requireReportAccess(actor, definition);

  if (!permitted.ok) {
    return permitted;
  }

  if (key === "system-health") {
    const health = await healthRows(permitted.value);
    return ok(offset === 0 ? health.rows : []);
  }

  return reportsRepository.datasetPage(key, filters, limit, offset);
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

async function listPresets(
  actor: AppUser | null,
  report?: ReportKey,
): Promise<Result<readonly ReportPresetRow[]>> {
  if (!actor) {
    return fail(new ForbiddenError("No signed-in user for presets"));
  }

  return presetsRepository.listFor(actor.id, report);
}

async function savePreset(input: unknown, actor: AppUser | null): Promise<Result<ReportPresetRow>> {
  if (!actor) {
    return fail(new ForbiddenError("No signed-in user to save a preset"));
  }

  const parsed = savePresetSchema.safeParse(input);

  if (!parsed.success) {
    return fail(
      new ValidationError("Preset is not valid", {
        fieldErrors: { name: parsed.error.issues[0]?.message ?? "Invalid" },
      }),
    );
  }

  /*
   * A preset for a report the caller may not run would be a stored pointer to
   * data they cannot see. Refused rather than saved and later refused on use.
   */
  const permitted = requireReportAccess(actor, definitionFor(parsed.data.report));

  if (!permitted.ok) {
    return permitted;
  }

  return presetsRepository.save({
    userId: actor.id,
    report: parsed.data.report,
    name: parsed.data.name,
    filters: parsed.data.filters,
    columns: parsed.data.columns,
    sort: parsed.data.sort,
    exportFormat: parsed.data.exportFormat,
  });
}

async function deletePreset(id: string, actor: AppUser | null): Promise<Result<ReportPresetRow>> {
  if (!actor) {
    return fail(new ForbiddenError("No signed-in user to delete a preset"));
  }

  return presetsRepository.remove(id, actor.id);
}

export const reportsService = {
  catalogue,
  run,
  datasetPage,
  listPresets,
  savePreset,
  deletePreset,
  canRun: (actor: AppUser | null, key: ReportKey) =>
    requireReportAccess(actor, definitionFor(key)).ok,
} as const;
