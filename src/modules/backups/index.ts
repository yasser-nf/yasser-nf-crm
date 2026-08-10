/**
 * Backups module — public API. ADR-003 Rule 2.
 *
 * Backup, restore and integrity for the whole CRM. Super Admin only, enforced
 * in the services rather than at the screen.
 *
 * Repositories and the storage adapter are NOT exported. Both can read and
 * write every table in the system, so exposing either would offer a route past
 * the permission checks that make this module safe.
 */
export { backupService } from "./services/backup.service";
export { restoreService } from "./services/restore.service";
export { snapshotService, isDue } from "./services/snapshot.service";
export { checksumService } from "./services/checksum.service";

export type {
  RestoreOutcome,
  RestorePreview,
  TableChange,
  OrphanUser,
} from "./services/restore.service";

export {
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLES,
  BACKUP_TABLE_NAMES,
  checkCompatibility,
  policyFor,
  type BackupManifest,
  type RestorePolicy,
} from "./services/backup-format";

export {
  planRetention,
  DEFAULT_KEEP_LAST,
  type RetentionCandidate,
  type RetentionPlan,
} from "./services/retention";

export { BackupsTable, CreateBackupControls } from "./components/backups-table";
export { BackupDetailView } from "./components/backup-detail";

export type { BackupFilter } from "./repositories/backups.repository";

export {
  backupFrequencySchema,
  backupSettingsSchema,
  createBackupSchema,
  parseBackupSettings,
  type BackupFrequency,
  type BackupSettings,
} from "./validation/backup.schema";
