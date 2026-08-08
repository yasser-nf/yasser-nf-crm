/**
 * Backups module — public API. ADR-003 Rule 2.
 *
 * Metadata only. The Backup Engine that produces artefacts is a later milestone.
 */
export type { BackupsRepository, BackupFilter } from "./repositories/backups.repository";
export { backupsRepository } from "./repositories/backups.repository";

export {
  backupInsertSchema,
  backupSelectSchema,
  backupUpdateSchema,
  type BackupInsert,
  type BackupSelect,
  type BackupUpdate,
} from "./validation/backup.schema";
