/**
 * Reports module — public API. ADR-003 Rule 2.
 *
 * Read-only over every other module's data, plus one small table of its own for
 * saved presets. It computes no business rules: the health report reuses
 * `assessHealth` from M09, and every figure is aggregate SQL rather than rows
 * counted in JavaScript.
 *
 * Repositories are NOT exported. Between them they can read every business
 * table in the system, and exposing either would offer a route past the
 * per-report permission check that decides what a caller may see.
 *
 * The serialisers ARE exported. They are pure functions over rows and columns
 * with no data access at all, and the export route needs them.
 */
export { reportsService, PREVIEW_PAGE_SIZE } from "./services/reports.service";
export type { ReportPayload } from "./services/reports.service";

export { exportService, EXPORT_PAGE_SIZE, EXPORT_ROW_LIMIT } from "./services/export.service";
export type { ExportDescriptor } from "./services/export.service";

export { csvService } from "./services/csv.service";
export { excelService } from "./services/excel.service";
export { pdfService } from "./services/pdf.service";

export {
  REPORT_DEFINITIONS,
  REPORT_KEYS,
  definitionFor,
  isReportKey,
  reportsFor,
  type FilterKey,
  type ReportColumn,
  type ReportDefinition,
  type ReportKey,
} from "./services/report-definitions";

export {
  describeFilters,
  exportFormatSchema,
  parseFilters,
  reportFiltersSchema,
  reportKeySchema,
  savePresetSchema,
  type ExportFormat,
  type ReportFilters,
  type SavePresetInput,
} from "./validation/report.schema";

export type { ReportRow, ReportSummary } from "./repositories/reports.repository";

export { ReportsCatalogue } from "./components/reports-catalogue";
export { ReportView } from "./components/report-view";
