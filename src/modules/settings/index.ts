/**
 * Settings module — public API. ADR-003 Rule 2.
 *
 * The single source of configuration. Business modules read values through
 * `configurationService` and never declare or write one of their own.
 *
 * The repository is exported for one historical reason: the backups module has
 * read the settings row through it since M07. Everything added in M11 goes
 * through the services, which validate, authorize and audit — writing through
 * the repository would bypass all three.
 */
export { settingsService } from "./services/settings.service";
export type { SettingsView } from "./services/settings.service";

export { configurationService } from "./services/configuration.service";
export { systemService } from "./services/system.service";
export type { SystemInformation } from "./services/system.service";

export {
  validationService,
  validateConfiguration,
  hasBlockingIssue,
  type ConfigurationIssue,
  type IssueSeverity,
} from "./services/validation.service";

export {
  SETTINGS_CATEGORIES,
  SETTING_DEFINITIONS,
  definitionForKey,
  definitionsForCategory,
  enforcementNote,
  isSettingsCategory,
  searchDefinitions,
  type Enforcement,
  type SettingDefinition,
  type SettingsCategory,
  type SettingType,
} from "./services/settings-definitions";

export {
  CATEGORY_SCHEMAS,
  backupFrequencySchema,
  backupScheduleSchema,
  backupSettingsSchema,
  companySettingsSchema,
  configurationSchema,
  generalSettingsSchema,
  notificationSettingsSchema,
  parseConfiguration,
  retentionPolicySchema,
  securitySettingsSchema,
  type BackupFrequency,
  type BackupSchedule,
  type BackupSettings,
  type CompanySettings,
  type Configuration,
  type GeneralSettings,
  type NotificationSettings,
  type RetentionPolicy,
  type SecuritySettings,
} from "./validation/configuration.schema";

export type { SettingsRepository } from "./repositories/settings.repository";
export { settingsRepository } from "./repositories/settings.repository";
export type { SettingsChange } from "./repositories/settings.repository";

export {
  settingsSelectSchema,
  settingsUpdateSchema,
  type SettingsSelect,
  type SettingsUpdate,
} from "./validation/settings.schema";

export { SettingsForm } from "./components/settings-form";
export { SettingsCategorySection } from "./components/category-section";
export { SettingsCategoryGrid, SettingsNav, SettingsSearch } from "./components/settings-shell";
export { SettingsHistory, SettingsSearchResults, SystemPanel } from "./components/settings-panels";
