import { z } from "zod";

import { REPORT_KEYS } from "../services/report-definitions";

/**
 * Report inputs.
 *
 * Filters arrive from a query string, which is untrusted regardless of what the
 * UI put there. 02_ARCHITECTURE.md requires validation at the boundary, and
 * these values reach SQL — as bound parameters, never as text, but a malformed
 * uuid or an unknown status should be refused before it gets that far.
 */

export const reportKeySchema = z.enum(REPORT_KEYS);

export const exportFormatSchema = z.enum(["csv", "excel", "pdf"]);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

/** An ISO date, or nothing. Kept as a string: the SQL casts it. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .optional();

export const reportFiltersSchema = z
  .object({
    from: isoDate,
    to: isoDate,
    status: z.string().trim().max(40).optional(),
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
    problemType: z
      .enum([
        "payment_problem",
        "incorrect_password",
        "invalid_email",
        "something_went_wrong",
        "other",
      ])
      .optional(),
    backupType: z.enum(["hourly", "daily", "weekly", "monthly", "manual", "snapshot"]).optional(),
    workerId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(),
    search: z.string().trim().max(200).optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "The start of the range must not be after its end",
    path: ["from"],
  });

export type ReportFilters = z.infer<typeof reportFiltersSchema>;

export const savePresetSchema = z.object({
  report: reportKeySchema,
  name: z.string().trim().min(1, "Name the preset").max(80),
  filters: reportFiltersSchema,
  columns: z.array(z.string()).max(40).default([]),
  sort: z
    .object({ key: z.string().max(40), direction: z.enum(["asc", "desc"]) })
    .partial()
    .default({}),
  exportFormat: exportFormatSchema.default("csv"),
});

export type SavePresetInput = z.infer<typeof savePresetSchema>;

/**
 * Parses a query string into filters.
 *
 * Unknown keys are dropped rather than rejected: a stale bookmark carrying a
 * filter that no longer exists should still open the report.
 */
export function parseFilters(params: Record<string, string | string[] | undefined>): ReportFilters {
  const read = (key: string): string | undefined => {
    const value = params[key];
    const single = Array.isArray(value) ? value[0] : value;
    return single && single.length > 0 ? single : undefined;
  };

  const candidate = {
    from: read("from"),
    to: read("to"),
    status: read("status"),
    severity: read("severity"),
    problemType: read("problemType"),
    backupType: read("backupType"),
    workerId: read("workerId"),
    customerId: read("customerId"),
    accountId: read("accountId"),
    search: read("search"),
  };

  const parsed = reportFiltersSchema.safeParse(candidate);

  return parsed.success ? parsed.data : {};
}

/** Human-readable filter list, for the print header and the screen. */
export function describeFilters(filters: ReportFilters): string[] {
  const lines: string[] = [];

  if (filters.from || filters.to) {
    lines.push(`Date range: ${filters.from ?? "any"} to ${filters.to ?? "any"}`);
  }

  for (const [label, value] of [
    ["Status", filters.status],
    ["Severity", filters.severity],
    ["Problem type", filters.problemType],
    ["Backup type", filters.backupType],
    ["Search", filters.search],
  ] as const) {
    if (value) {
      lines.push(`${label}: ${value}`);
    }
  }

  for (const [label, value] of [
    ["Worker", filters.workerId],
    ["Customer", filters.customerId],
    ["Account", filters.accountId],
  ] as const) {
    if (value) {
      lines.push(`${label}: ${value}`);
    }
  }

  return lines;
}
