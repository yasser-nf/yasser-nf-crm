import "server-only";

import { PERMISSIONS, USER_ROLES, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { auditService, type AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { settingsRepository, type SettingsChange } from "../repositories/settings.repository";
import {
  CATEGORY_SCHEMAS,
  parseConfiguration,
  type Configuration,
} from "../validation/configuration.schema";
import {
  SETTING_DEFINITIONS,
  definitionsForCategory,
  searchDefinitions,
  type SettingDefinition,
  type SettingsCategory,
} from "./settings-definitions";
import { validationService, type ConfigurationIssue } from "./validation.service";

/**
 * Settings service.
 *
 * The single source of configuration. Every read and every write goes through
 * here, which is what lets three guarantees hold without depending on anyone
 * remembering them:
 *
 *   validated  — the category schema runs, then the cross-field rules
 *   audited    — every change writes an audit entry with before and after
 *   authorized — reading and writing are separate permissions
 *
 * Business modules consume configuration through `configurationService`. They
 * never write it, and they never declare a setting of their own.
 */

/** Which jsonb key a category lives under. */
const CATEGORY_KEY: Record<SettingsCategory, keyof Configuration | null> = {
  general: "general",
  company: "company",
  security: "security",
  notifications: "notifications",
  backups: "backup",
  /* System is read-only measurement, not stored configuration. */
  system: null,
};

export interface SettingsView {
  readonly configuration: Configuration;
  readonly definitions: readonly SettingDefinition[];
  readonly issues: readonly ConfigurationIssue[];
  readonly canEdit: boolean;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
}

function requireRead(actor: AppUser | null): Result<AppUser> {
  if (!actor) {
    return fail(
      new ForbiddenError("No signed-in user for settings", {
        userMessage: "Sign in to view settings.",
      }),
    );
  }

  return ok(actor);
}

function requireWrite(
  actor: AppUser | null,
  permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS],
): Result<AppUser> {
  const readable = requireRead(actor);

  if (!readable.ok) {
    return readable;
  }

  if (!roleHasPermission(readable.value.role, permission)) {
    return fail(
      new ForbiddenError(`Role ${readable.value.role} may not change settings`, {
        userMessage: "Only a Super Admin can change settings.",
        context: { actorId: readable.value.id, role: readable.value.role, permission },
      }),
    );
  }

  return ok(readable.value);
}

/**
 * Redacts what a Worker may not see.
 *
 * Security settings describe how the system defends itself — lockout
 * thresholds, session limits — and handing them to every signed-in user tells
 * an attacker exactly how many attempts they have. The values are removed from
 * the payload rather than hidden in the markup, so they never reach the
 * browser at all.
 */
function visibleDefinitions(actor: AppUser): readonly SettingDefinition[] {
  if (actor.role === USER_ROLES.SUPER_ADMIN) {
    return SETTING_DEFINITIONS;
  }

  return SETTING_DEFINITIONS.filter((definition) => definition.readableByWorker);
}

function redact(configuration: Configuration, actor: AppUser): Configuration {
  if (actor.role === USER_ROLES.SUPER_ADMIN) {
    return configuration;
  }

  /*
   * A Worker keeps general and company — the application name and the support
   * contact are things they legitimately need — and loses the rest.
   */
  return {
    general: configuration.general,
    company: configuration.company,
    security: {} as Configuration["security"],
    notifications: {} as Configuration["notifications"],
    backup: {} as Configuration["backup"],
  };
}

/** The whole configuration, filtered to what this caller may see. */
async function load(actor: AppUser | null): Promise<Result<SettingsView>> {
  const permitted = requireRead(actor);

  if (!permitted.ok) {
    return permitted;
  }

  const row = await settingsRepository.ensureExists();

  if (!row.ok) {
    return row;
  }

  const configuration = parseConfiguration(row.value.values);
  const canEdit = roleHasPermission(permitted.value.role, PERMISSIONS.ACCESS_SETTINGS);

  return ok({
    configuration: redact(configuration, permitted.value),
    definitions: visibleDefinitions(permitted.value),
    /* Issues describe the real configuration, so only an editor sees them. */
    issues: canEdit ? validationService.validate(configuration) : [],
    canEdit,
    updatedAt: row.value.updatedAt,
    updatedBy: row.value.updatedBy,
  });
}

/**
 * Updates one category.
 *
 * Category at a time rather than the whole document: two people editing
 * different pages must not overwrite each other's section, and a partial write
 * is the only shape that makes that true.
 */
async function updateCategory(
  category: SettingsCategory,
  input: unknown,
  context: AuditContext,
): Promise<Result<Configuration>> {
  const key = CATEGORY_KEY[category];

  if (!key) {
    return fail(
      new ValidationError(`Category ${category} is not editable`, {
        userMessage: "System information is measured, not configured.",
      }),
    );
  }

  /*
   * Backups carry their own permission. A category that needed ACCESS_SETTINGS
   * to change backup retention would widen who can touch the backup policy.
   */
  const permission =
    category === "backups" ? PERMISSIONS.ACCESS_BACKUPS : PERMISSIONS.ACCESS_SETTINGS;

  const permitted = requireWrite(context.actor, permission);

  if (!permitted.ok) {
    return permitted;
  }

  const schema = CATEGORY_SCHEMAS[key];
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};

    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".");
      if (path && !(path in fieldErrors)) {
        fieldErrors[path] = issue.message;
      }
    }

    return fail(new ValidationError("Settings failed validation", { fieldErrors }));
  }

  const row = await settingsRepository.ensureExists();

  if (!row.ok) {
    return row;
  }

  const before = parseConfiguration(row.value.values);
  const after: Configuration = { ...before, [key]: parsed.data };

  /* Cross-field rules run against the merged result, never the fragment. */
  const issues = validationService.validate(after);

  if (validationService.hasBlockingIssue(issues)) {
    const blocking = issues.filter((issue) => issue.severity === "error");

    return fail(
      new ValidationError("Settings combination is not valid", {
        userMessage: blocking[0]?.message ?? "These settings conflict with each other.",
        context: { issues: blocking },
      }),
    );
  }

  const updated = await settingsRepository.update({
    values: after as unknown as Record<string, unknown>,
    updatedBy: permitted.value.id,
  });

  if (!updated.ok) {
    return updated;
  }

  /*
   * Audited with before and after for this category only. Recording the whole
   * document would bury the one field that changed in forty that did not.
   */
  await auditService.recordOrWarn(
    {
      entity: "settings",
      entityId: row.value.id,
      action: "update",
      before: { [key]: before[key] },
      after: { [key]: parsed.data },
    },
    context,
  );

  return ok(after);
}

/** Every setting matching a query, for the search box. */
function search(query: string, actor: AppUser | null): readonly SettingDefinition[] {
  if (!actor) {
    return [];
  }

  const visible = visibleDefinitions(actor);
  const matches = searchDefinitions(query);

  return matches.filter((definition) => visible.includes(definition));
}

function forCategory(
  category: SettingsCategory,
  actor: AppUser | null,
): readonly SettingDefinition[] {
  if (!actor) {
    return [];
  }

  const visible = visibleDefinitions(actor);

  return definitionsForCategory(category).filter((definition) => visible.includes(definition));
}

/**
 * Change history for the settings row.
 *
 * Read from `audit_logs`, never from a second table. Every settings change is
 * already recorded there with before and after, which is exactly what the M11
 * brief asks the history to show.
 */
async function history(
  actor: AppUser | null,
  limit = 50,
): Promise<Result<readonly SettingsChange[]>> {
  /*
   * Gated on the write permission rather than the read one. The history shows
   * old and new values of every setting, including the security thresholds a
   * Worker is not permitted to see in the first place.
   */
  const permitted = requireWrite(actor, PERMISSIONS.ACCESS_SETTINGS);

  if (!permitted.ok) {
    return permitted;
  }

  return settingsRepository.history(limit);
}

export const settingsService = {
  load,
  updateCategory,
  search,
  forCategory,
  history,
} as const;
