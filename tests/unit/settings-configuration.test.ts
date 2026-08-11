import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "@/config/roles";
import {
  SETTINGS_CATEGORIES,
  SETTING_DEFINITIONS,
  definitionForKey,
  definitionsForCategory,
  enforcementNote,
  isSettingsCategory,
  searchDefinitions,
} from "@/modules/settings/services/settings-definitions";
import {
  parseConfiguration,
  configurationSchema,
} from "@/modules/settings/validation/configuration.schema";
import { validateConfiguration } from "@/modules/settings/services/validation.service";

/**
 * Settings catalogue and validation tests.
 *
 * Two things matter most here and both are pinned: that a setting the system
 * cannot enforce is always labelled as such, and that the cross-field rules
 * actually block the combinations they claim to.
 */

const DEFAULTS = configurationSchema.parse({});

describe("catalogue", () => {
  it("gives every setting a unique key", () => {
    const keys = SETTING_DEFINITIONS.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("prefixes every key with a known category root", () => {
    for (const definition of SETTING_DEFINITIONS) {
      expect(definition.key).toContain(".");
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  it("only names permissions that exist", () => {
    const known = new Set(Object.values(PERMISSIONS));

    for (const definition of SETTING_DEFINITIONS) {
      expect(known.has(definition.permission), definition.key).toBe(true);
    }
  });

  it("has no theme setting", () => {
    /*
     * 01_MASTER_RULES.md and 04_UI_GUIDELINES.md both fix the interface to dark
     * and 04 forbids a switcher. ADR-012 Decision 1 records the omission — this
     * fails if somebody adds one back without revisiting that.
     */
    const keys = SETTING_DEFINITIONS.map((definition) => definition.key.toLowerCase());
    expect(keys.some((key) => key.includes("theme"))).toBe(false);
  });

  it("gives every unenforced setting a reason", () => {
    for (const definition of SETTING_DEFINITIONS) {
      if (definition.enforcement.state === "enforced") {
        expect(enforcementNote(definition)).toBeNull();
      } else {
        const note = enforcementNote(definition);
        expect(note, definition.key).toBeTruthy();
        expect(note!.length).toBeGreaterThan(10);
      }
    }
  });

  it("never marks a security setting readable by a Worker", () => {
    /* Lockout thresholds tell an attacker how many attempts they have. */
    for (const definition of definitionsForCategory("security")) {
      expect(definition.readableByWorker, definition.key).toBe(false);
    }
  });

  it("keeps general and company readable by a Worker", () => {
    for (const category of ["general", "company"] as const) {
      for (const definition of definitionsForCategory(category)) {
        expect(definition.readableByWorker, definition.key).toBe(true);
      }
    }
  });

  it("marks the password policy as enforced elsewhere, never as active", () => {
    /* ADR-008 D2: the CRM never sees a password, so it cannot enforce one. */
    const policy = definitionForKey("security.passwordMinLength");

    expect(policy).not.toBeNull();
    expect(policy!.enforcement.state).toBe("external");
  });

  it("marks every notification switch as pending", () => {
    for (const definition of definitionsForCategory("notifications")) {
      expect(definition.enforcement.state, definition.key).toBe("pending");
    }
  });

  it("recognises only known categories", () => {
    for (const category of SETTINGS_CATEGORIES) {
      expect(isSettingsCategory(category)).toBe(true);
    }

    expect(isSettingsCategory("billing")).toBe(false);
  });

  it("searches key, label and description", () => {
    expect(searchDefinitions("retention").length).toBeGreaterThan(0);
    expect(searchDefinitions("timezone").length).toBeGreaterThan(0);
    /* By description wording rather than by label. */
    expect(searchDefinitions("printed reports").length).toBeGreaterThan(0);
    expect(searchDefinitions("zzzz")).toEqual([]);
  });

  it("returns everything for an empty search", () => {
    expect(searchDefinitions("").length).toBe(SETTING_DEFINITIONS.length);
    expect(searchDefinitions("   ").length).toBe(SETTING_DEFINITIONS.length);
  });
});

describe("parseConfiguration", () => {
  it("produces a complete configuration from nothing", () => {
    const configuration = parseConfiguration({});

    expect(configuration.general.applicationName).toBeTruthy();
    expect(configuration.security.passwordMinLength).toBeGreaterThanOrEqual(8);
    expect(configuration.backup.retention.keepLast).toBeGreaterThan(0);
  });

  it("never throws on arbitrary input", () => {
    /* The jsonb column is the one place a value can be anything at all. */
    for (const input of [null, undefined, 42, "text", [], { general: "not an object" }]) {
      expect(() => parseConfiguration(input)).not.toThrow();
    }
  });

  it("keeps valid categories when another is malformed", () => {
    const configuration = parseConfiguration({
      general: { applicationName: "Kept" },
      security: { passwordMinLength: "not a number" },
    });

    expect(configuration.general.applicationName).toBe("Kept");
    /* The bad category falls back rather than taking the good one with it. */
    expect(configuration.security.passwordMinLength).toBe(DEFAULTS.security.passwordMinLength);
  });

  it("rejects a timezone that is not IANA-shaped", () => {
    const configuration = parseConfiguration({ general: { timezone: "Mars/Olympus Mons!" } });
    expect(configuration.general.timezone).toBe(DEFAULTS.general.timezone);
  });

  it("accepts an empty optional company field", () => {
    const configuration = parseConfiguration({ company: { email: "", website: "" } });

    expect(configuration.company.email).toBe("");
    expect(configuration.company.website).toBe("");
  });
});

describe("validateConfiguration", () => {
  function withSecurity(overrides: Partial<typeof DEFAULTS.security>) {
    return { ...DEFAULTS, security: { ...DEFAULTS.security, ...overrides } };
  }

  it("passes a default configuration with no errors", () => {
    const issues = validateConfiguration(DEFAULTS);
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("blocks a session timeout longer than the inactivity threshold", () => {
    const issues = validateConfiguration(
      withSecurity({ sessionTimeoutMinutes: 10_000, inactiveUserDays: 1 }),
    );

    const blocking = issues.filter((issue) => issue.severity === "error");
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking[0]?.key).toBe("security.sessionTimeoutMinutes");
  });

  it("warns when locking after a single failed attempt", () => {
    const issues = validateConfiguration(withSecurity({ lockAfterFailedAttempts: 1 }));

    expect(
      issues.some(
        (issue) => issue.key === "security.lockAfterFailedAttempts" && issue.severity === "warning",
      ),
    ).toBe(true);
  });

  it("warns when account locking is disabled", () => {
    const issues = validateConfiguration(withSecurity({ lockAfterFailedAttempts: 0 }));
    expect(issues.some((issue) => issue.message.includes("disabled"))).toBe(true);
  });

  it("warns when hourly backups keep less than a day", () => {
    const configuration = {
      ...DEFAULTS,
      backup: {
        schedule: { frequency: "hourly" as const, hourUtc: 2 },
        retention: { keepLast: 5 },
      },
    };

    const issues = validateConfiguration(configuration);
    expect(issues.some((issue) => issue.key === "backup.retention.keepLast")).toBe(true);
  });

  it("warns when notification types are on but email delivery is off", () => {
    const configuration = {
      ...DEFAULTS,
      notifications: { ...DEFAULTS.notifications, email: false, problems: true },
    };

    const issues = validateConfiguration(configuration);
    expect(issues.some((issue) => issue.key === "notifications.email")).toBe(true);
  });

  it("warns when email notifications have no sender address", () => {
    const configuration = {
      ...DEFAULTS,
      notifications: { ...DEFAULTS.notifications, email: true },
      company: { ...DEFAULTS.company, email: "" },
    };

    const issues = validateConfiguration(configuration);
    expect(issues.some((issue) => issue.key === "company.email")).toBe(true);
  });

  it("never blocks on a warning alone", () => {
    /* Warnings describe legal-but-odd combinations; refusing them would argue
     * with somebody who knows what they want. */
    const issues = validateConfiguration(withSecurity({ lockAfterFailedAttempts: 0 }));
    expect(issues.every((issue) => issue.severity === "warning")).toBe(true);
  });

  it("points every issue at a real setting key", () => {
    const configuration = withSecurity({ sessionTimeoutMinutes: 10_000, inactiveUserDays: 1 });
    const known = new Set(SETTING_DEFINITIONS.map((definition) => definition.key));

    for (const issue of validateConfiguration(configuration)) {
      expect(known.has(issue.key), issue.key).toBe(true);
    }
  });
});
