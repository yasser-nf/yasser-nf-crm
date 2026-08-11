import "server-only";

import { settingsRepository } from "../repositories/settings.repository";
import {
  parseConfiguration,
  type CompanySettings,
  type Configuration,
  type GeneralSettings,
  type NotificationSettings,
  type SecuritySettings,
} from "../validation/configuration.schema";

/**
 * How business modules read configuration.
 *
 * The M11 architectural rule: business modules consume settings, they never own
 * them. This is the consuming surface — typed accessors with no permission
 * checks, because a module reading its own configuration is not a user action.
 *
 * Deliberately read-only. There is no `set` here at all: writing goes through
 * `settingsService`, which validates, audits and authorizes. A module that
 * could write configuration directly would bypass all three.
 *
 * Every accessor returns a complete, defaulted object. A caller never has to
 * handle a missing setting, which is what stops defaults being re-declared at
 * each call site — the duplication M11 forbids.
 */

async function all(): Promise<Configuration> {
  const row = await settingsRepository.ensureExists();

  /*
   * Falls back to defaults rather than failing. A module asking for the date
   * format must not break because the settings read did — and
   * `parseConfiguration` never throws.
   */
  return parseConfiguration(row.ok ? row.value.values : {});
}

async function general(): Promise<GeneralSettings> {
  return (await all()).general;
}

async function company(): Promise<CompanySettings> {
  return (await all()).company;
}

async function security(): Promise<SecuritySettings> {
  return (await all()).security;
}

async function notifications(): Promise<NotificationSettings> {
  return (await all()).notifications;
}

/**
 * Whether a notification of a given kind should be sent.
 *
 * Two conditions, in one place: the channel must be on AND the specific type
 * must be enabled. Every future caller asking "should I notify?" gets the same
 * answer, rather than each one deciding how to combine the two switches.
 *
 * Nothing calls this yet — the notifications module is deferred (ADR-005 D1).
 * It exists so that when a sender arrives, the rule is already settled.
 */
async function shouldNotify(kind: keyof Omit<NotificationSettings, "email">): Promise<boolean> {
  const settings = await notifications();
  return settings.email && settings[kind];
}

export const configurationService = {
  all,
  general,
  company,
  security,
  notifications,
  shouldNotify,
} as const;
