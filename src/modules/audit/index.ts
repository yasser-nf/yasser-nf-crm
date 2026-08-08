/**
 * Audit module — public API. ADR-003 Rule 2.
 *
 * Deliberately exposes no way to modify or delete a log entry.
 */
export type { AuditRepository, AuditFilter } from "./repositories/audit.repository";
export { auditRepository } from "./repositories/audit.repository";

export { auditService, type AuditContext, type RecordAuditInput } from "./services/audit.service";

export {
  auditLogInsertSchema,
  auditLogSelectSchema,
  type AuditLogInsert,
  type AuditLogSelect,
} from "./validation/audit-log.schema";
