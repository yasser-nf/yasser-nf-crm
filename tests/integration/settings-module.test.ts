import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { ForbiddenError } from "@/lib/errors";

/**
 * Settings integration tests, against the real database.
 *
 * These write to the singleton settings row, so the original `values` is
 * captured in `beforeAll` and restored in `afterAll`. Nothing else in the
 * system is touched.
 *
 * Skipped automatically when no real project is configured.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

let superAdmin: AppUser;
let worker: AppUser;
let originalValues: unknown = {};

beforeAll(async () => {
  if (!configured) return;

  const admins = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users
    where role = 'super_admin' and status = 'active' and deleted_at is null limit 1
  `;

  const admin = admins[0];
  if (!admin) throw new Error("No active Super Admin to authorize as");

  superAdmin = {
    id: admin.id,
    email: admin.email,
    displayName: admin.name,
    initials: "SA",
    role: "super_admin",
  };

  const workers = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users where role = 'worker' and deleted_at is null limit 1
  `;

  const row = workers[0];

  worker = row
    ? { id: row.id, email: row.email, displayName: row.name, initials: "WK", role: "worker" }
    : {
        id: "3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607",
        email: "worker@example.invalid",
        displayName: "Worker",
        initials: "WK",
        role: "worker",
      };

  /* Capture the real configuration so it can be put back exactly. */
  const existing = await sql!<{ values: unknown }[]>`
    select values from public.settings where singleton = true limit 1
  `;

  originalValues = existing[0]?.values ?? {};
});

afterAll(async () => {
  if (!configured) return;

  await sql!`
    update public.settings
    set values = ${JSON.stringify(originalValues)}::jsonb
    where singleton = true
  `;

  await sql!.end({ timeout: 5 });
});

async function services() {
  const { settingsService } = await import("@/modules/settings/services/settings.service");
  const { configurationService } =
    await import("@/modules/settings/services/configuration.service");
  const { systemService } = await import("@/modules/settings/services/system.service");

  return { settingsService, configurationService, systemService };
}

describe.skipIf(!configured)("reading configuration", () => {
  it("loads a complete configuration for a Super Admin", async () => {
    const { settingsService } = await services();
    const result = await settingsService.load(superAdmin);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      expect(result.value.canEdit).toBe(true);
      expect(result.value.configuration.general.applicationName).toBeTruthy();
      expect(result.value.configuration.security.passwordMinLength).toBeGreaterThanOrEqual(8);
      expect(result.value.definitions.length).toBeGreaterThan(20);
    }
  });

  it("gives business modules typed values without a permission check", async () => {
    /* A module reading its own configuration is not a user action. */
    const { configurationService } = await services();

    const general = await configurationService.general();
    const security = await configurationService.security();

    expect(typeof general.applicationName).toBe("string");
    expect(typeof security.sessionTimeoutMinutes).toBe("number");
  });

  it("refuses an unauthenticated caller", async () => {
    const { settingsService } = await services();

    expect((await settingsService.load(null)).ok).toBe(false);
    expect((await settingsService.history(null)).ok).toBe(false);
  });
});

describe.skipIf(!configured)("RBAC — a Worker sees less and changes nothing", () => {
  it("redacts security, backups and notifications from a Worker", async () => {
    /*
     * Asserting the payload rather than the markup: a value that never reaches
     * the browser cannot be read out of the HTML.
     */
    const { settingsService } = await services();
    const result = await settingsService.load(worker);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      expect(result.value.canEdit).toBe(false);
      expect(result.value.configuration.security).toEqual({});
      expect(result.value.configuration.notifications).toEqual({});
      expect(result.value.configuration.backup).toEqual({});

      /* But keeps what they legitimately need. */
      expect(result.value.configuration.general.applicationName).toBeTruthy();
    }
  });

  it("hides restricted definitions from a Worker's catalogue", async () => {
    const { settingsService } = await services();
    const result = await settingsService.load(worker);

    expect(result.ok).toBe(true);

    if (result.ok) {
      const categories = new Set(result.value.definitions.map((d) => d.category));

      expect(categories.has("general")).toBe(true);
      expect(categories.has("security")).toBe(false);
      expect(categories.has("notifications")).toBe(false);
    }
  });

  it("refuses a Worker changing any category", async () => {
    const { settingsService } = await services();

    for (const category of ["general", "security", "backups", "notifications"] as const) {
      const result = await settingsService.updateCategory(category, {}, { actor: worker });

      expect(result.ok, `worker changed ${category}`).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
    }
  });

  it("refuses a Worker reading the change history", async () => {
    const { settingsService } = await services();
    const result = await settingsService.history(worker);

    expect(result.ok).toBe(false);
  });

  it("returns no search results for an unauthenticated caller", async () => {
    const { settingsService } = await services();
    expect(settingsService.search("timezone", null)).toEqual([]);
  });
});

describe.skipIf(!configured)("persistence, validation and audit", () => {
  it("persists a change and reads it back", async () => {
    const { settingsService, configurationService } = await services();

    const result = await settingsService.updateCategory(
      "general",
      {
        applicationName: "M11 Verification CRM",
        timezone: "Africa/Algiers",
        dateFormat: "european",
        language: "en",
        currency: "EUR",
      },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    /* Read through the consuming surface, not the one that wrote it. */
    const general = await configurationService.general();

    expect(general.applicationName).toBe("M11 Verification CRM");
    expect(general.dateFormat).toBe("european");
    expect(general.currency).toBe("EUR");
  });

  it("leaves other categories untouched when one is written", async () => {
    /* Category-at-a-time is what stops two editors overwriting each other. */
    const { settingsService, configurationService } = await services();

    const before = await configurationService.security();

    await settingsService.updateCategory(
      "company",
      {
        name: "M11 Test Co",
        logoUrl: "",
        address: "",
        phone: "",
        email: "",
        website: "",
        supportContact: "",
      },
      { actor: superAdmin },
    );

    const after = await configurationService.security();

    expect(after).toEqual(before);
    expect((await configurationService.company()).name).toBe("M11 Test Co");
  });

  it("writes an audit entry with before and after", async () => {
    const { settingsService } = await services();

    const beforeCount = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.audit_logs
      where entity = 'settings' and action = 'update'
    `;

    await settingsService.updateCategory(
      "general",
      {
        applicationName: "M11 Audited Name",
        timezone: "UTC",
        dateFormat: "iso",
        language: "en",
        currency: "DZD",
      },
      { actor: superAdmin },
    );

    const afterCount = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.audit_logs
      where entity = 'settings' and action = 'update'
    `;

    expect(afterCount[0]!.n).toBe(beforeCount[0]!.n + 1);

    const latest = await sql!<{ before: unknown; after: unknown; user_id: string }[]>`
      select before, after, user_id from public.audit_logs
      where entity = 'settings' and action = 'update'
      order by created_at desc limit 1
    `;

    const entry = latest[0]!;
    expect(entry.user_id).toBe(superAdmin.id);
    expect(JSON.stringify(entry.after)).toContain("M11 Audited Name");
    /* The before must differ, or the history records nothing useful. */
    expect(JSON.stringify(entry.before)).not.toBe(JSON.stringify(entry.after));
  });

  it("surfaces the change in the history", async () => {
    const { settingsService } = await services();
    const history = await settingsService.history(superAdmin, 10);

    expect(history.ok, history.ok ? "" : String(history.error)).toBe(true);

    if (history.ok) {
      expect(history.value.length).toBeGreaterThan(0);
      expect(history.value[0]?.actorName).toBeTruthy();

      /* Newest first. */
      const times = history.value.map((change) => change.createdAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    }
  });

  it("rejects a value outside its range", async () => {
    const { settingsService } = await services();

    const result = await settingsService.updateCategory(
      "security",
      { ...{}, passwordMinLength: 4 },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a combination that contradicts itself", async () => {
    /* Session longer than the inactivity threshold — no session could ever be inactive. */
    const { settingsService } = await services();

    const result = await settingsService.updateCategory(
      "security",
      {
        sessionTimeoutMinutes: 10_000,
        maxConcurrentSessions: 5,
        passwordMinLength: 12,
        forceLogoutOnRoleChange: true,
        inactiveUserDays: 1,
        lockAfterFailedAttempts: 10,
      },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.userMessage).toContain("inactive");
  });

  it("does not persist a rejected change", async () => {
    const { configurationService } = await services();
    const security = await configurationService.security();

    /* The invalid values from the two tests above must not have landed. */
    expect(security.passwordMinLength).toBeGreaterThanOrEqual(8);
    expect(security.sessionTimeoutMinutes).toBeLessThanOrEqual(security.inactiveUserDays * 24 * 60);
  });

  it("refuses to write the system category", async () => {
    const { settingsService } = await services();
    const result = await settingsService.updateCategory("system", {}, { actor: superAdmin });

    expect(result.ok).toBe(false);
  });
});

describe.skipIf(!configured)("backups configuration stays shared, not duplicated", () => {
  it("is read back by the backups module through its own schema", async () => {
    const { settingsService } = await services();

    const written = await settingsService.updateCategory(
      "backups",
      { schedule: { frequency: "daily", hourUtc: 3 }, retention: { keepLast: 42 } },
      { actor: superAdmin },
    );

    expect(written.ok, written.ok ? "" : String(written.error)).toBe(true);

    /*
     * The point of the assertion: settings wrote it, and the backups module —
     * which owns the schema — reads the same value. One definition, not two.
     */
    const { backupService } = await import("@/modules/backups/services/backup.service");
    const read = await backupService.readSettings(superAdmin);

    expect(read.ok, read.ok ? "" : String(read.error)).toBe(true);

    if (read.ok) {
      expect(read.value.schedule.frequency).toBe("daily");
      expect(read.value.schedule.hourUtc).toBe(3);
      expect(read.value.retention.keepLast).toBe(42);
    }
  });
});

describe.skipIf(!configured)("system information", () => {
  it("reports live versions and migration state", async () => {
    const { systemService } = await services();
    const result = await systemService.information(superAdmin);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      expect(result.value.applicationVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(result.value.databaseVersion).toContain("PostgreSQL");
      expect(result.value.migrationsApplied).toBeGreaterThan(0);
      expect(["green", "yellow", "red"]).toContain(result.value.health.level);
      expect(result.value.storage.backupCount).toBeGreaterThanOrEqual(0);
      /* ADR-009 D2: the schedule is recorded but nothing fires it. */
      expect(result.value.scheduler.enforced).toBe(false);
    }
  });

  it("refuses a Worker", async () => {
    const { systemService } = await services();
    const result = await systemService.information(worker);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });
});
