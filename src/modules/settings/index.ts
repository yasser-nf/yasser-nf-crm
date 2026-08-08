/**
 * Settings module — public API. ADR-003 Rule 2.
 *
 * One row, guaranteed by a unique index rather than by convention.
 */
export type { SettingsRepository } from "./repositories/settings.repository";
export { settingsRepository } from "./repositories/settings.repository";

export {
  settingsSelectSchema,
  settingsUpdateSchema,
  type SettingsSelect,
  type SettingsUpdate,
} from "./validation/settings.schema";
