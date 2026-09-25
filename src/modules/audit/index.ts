/**
 * Audit module — public API. ADR-003 Rule 2.
 *
 * Deliberately exposes no way to modify or delete a log entry.
 */
export type { AuditRepository, AuditFilter } from "./repositories/audit.repository";
/*
 * The repository itself is NOT exported (M06). It can read every entry,
 * snapshots included; outside this module the log is read only through
 * `logsService`, which checks view_logs first and returns safe entries.
 */

export { auditService, type AuditContext, type RecordAuditInput } from "./services/audit.service";

/* M06: the Logs page. Entries leave the server only as `LogEntry`. */
export { logsService } from "./services/logs.service";
export {
  ACTION_LABELS,
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ENTITY_LABELS,
  EVENT_LABELS,
  LOGS_PAGE_SIZE,
  buildLogsSearch,
  hasActiveFilters,
  parseLogsFilter,
  toLogEntry,
  utcDayRange,
  utcDayStart,
  type LogEntry,
  type LogsFilterInput,
} from "./services/log-view";
export { LogsFilters } from "./components/logs-filters";
export { LogsTable, LogDetailDialog } from "./components/logs-table";

export {
  auditLogInsertSchema,
  auditLogSelectSchema,
  type AuditLogInsert,
  type AuditLogSelect,
} from "./validation/audit-log.schema";
