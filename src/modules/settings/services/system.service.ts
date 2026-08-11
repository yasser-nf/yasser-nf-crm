import "server-only";

import { sql } from "drizzle-orm";

import { APP_VERSION } from "@/config/constants";
import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { databaseAdapter } from "@/lib/database";
import { isBackupStorageConfigured, isDevelopment } from "@/config/env.server";
import { ForbiddenError } from "@/lib/errors";
import { assessHealth, type HealthReport } from "@/modules/dashboard";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { parseConfiguration } from "../validation/configuration.schema";
import { settingsRepository } from "../repositories/settings.repository";

/**
 * System information.
 *
 * Measured, never configured — which is why the System page has no form. Every
 * value here is read from the running system at the moment it is asked for, so
 * nothing on that page can disagree with reality.
 *
 * Health reuses `assessHealth` from M09 rather than restating the rule, so the
 * System page, the dashboard light and the System Health report can never
 * disagree about what "red" means.
 */

export interface SystemInformation {
  readonly applicationVersion: string;
  readonly databaseVersion: string;
  readonly lastMigration: string | null;
  readonly lastMigrationAt: Date | null;
  readonly migrationsApplied: number;
  readonly environment: "development" | "production";
  readonly health: HealthReport;
  readonly storage: {
    readonly backupBytes: number;
    readonly backupCount: number;
    readonly bucketConfigured: boolean;
  };
  readonly scheduler: {
    readonly frequency: string;
    readonly enforced: boolean;
    readonly note: string;
  };
}

function readNumber(row: Record<string, unknown> | undefined, key: string): number {
  const value = row?.[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

/**
 * Everything the System page shows.
 *
 * Super Admin only. Versions, migration state and storage usage describe how
 * the system is built and how much of it exists — 01_MASTER_RULES.md lists
 * system information among the things a Worker may not see.
 */
async function information(actor: AppUser | null): Promise<Result<SystemInformation>> {
  if (!actor) {
    return fail(new ForbiddenError("No signed-in user for system information"));
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.VIEW_SYSTEM_INFORMATION)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not view system information`, {
        userMessage: "System information is restricted to Super Admins.",
      }),
    );
  }

  const measured = await databaseAdapter.query("system.information", async (executor) => {
    const versionRows = await executor.execute(sql`select version() as version`);

    /*
     * drizzle-kit records applied migrations in its own schema. Reading it is
     * how the page can state which migration the database is actually at,
     * rather than which one the source tree contains.
     */
    const migrationRows = await executor.execute(sql`
      select hash, created_at
      from drizzle.__drizzle_migrations
      order by created_at desc
      limit 1
    `);

    const countRows = await executor.execute(sql`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `);

    const storageRows = await executor.execute(sql`
      select
        coalesce(sum(size_bytes) filter (where status in ('completed', 'verified')), 0)::float8 as bytes,
        count(*) filter (where status in ('completed', 'verified'))::int as count,
        (select count(*)::int from backups where status = 'failed') as failed,
        max(created_at) filter (where status in ('completed', 'verified')) as last_backup,
        (
          select status = 'verified' from backups
          where status in ('completed', 'verified')
          order by created_at desc limit 1
        ) as last_verified
      from backups
    `);

    const criticalRows = await executor.execute(sql`
      select count(*)::int as count from issues
      where severity = 'critical' and status in ('open', 'in_progress', 'waiting')
    `);

    return {
      version: (versionRows as unknown as { version: string }[])[0]?.version ?? "unknown",
      migration: (migrationRows as unknown as Record<string, unknown>[])[0] ?? undefined,
      count: (countRows as unknown as Record<string, unknown>[])[0] ?? undefined,
      storage: (storageRows as unknown as Record<string, unknown>[])[0] ?? undefined,
      critical: (criticalRows as unknown as Record<string, unknown>[])[0] ?? undefined,
    };
  });

  if (!measured.ok) {
    return measured;
  }

  const settingsRow = await settingsRepository.ensureExists();
  const configuration = parseConfiguration(settingsRow.ok ? settingsRow.value.values : {});

  const lastBackupRaw = measured.value.storage?.["last_backup"];
  const lastBackupAt =
    lastBackupRaw instanceof Date
      ? lastBackupRaw
      : lastBackupRaw
        ? new Date(String(lastBackupRaw))
        : null;

  const health = assessHealth(
    {
      criticalProblems: readNumber(measured.value.critical, "count"),
      failedBackups: readNumber(measured.value.storage, "failed"),
      lastBackupAt,
      lastChecksumVerified: measured.value.storage?.["last_verified"] === true,
      /* True because the reads above succeeded; a failure returned earlier. */
      databaseReachable: true,
    },
    new Date(),
  );

  const migrationHash = measured.value.migration?.["hash"];
  const migrationAtRaw = measured.value.migration?.["created_at"];

  return ok({
    applicationVersion: APP_VERSION,
    databaseVersion: measured.value.version.split(" ").slice(0, 2).join(" "),
    lastMigration: typeof migrationHash === "string" ? migrationHash.slice(0, 12) : null,
    lastMigrationAt: migrationAtRaw ? new Date(Number(migrationAtRaw)) : null,
    migrationsApplied: readNumber(measured.value.count, "count"),
    environment: isDevelopment ? "development" : "production",
    health,
    storage: {
      backupBytes: readNumber(measured.value.storage, "bytes"),
      backupCount: readNumber(measured.value.storage, "count"),
      bucketConfigured: isBackupStorageConfigured(),
    },
    scheduler: {
      frequency: configuration.backup.schedule.frequency,
      /* ADR-009 Decision 2: the schedule is stored and reported, never fired. */
      enforced: false,
      note:
        configuration.backup.schedule.frequency === "off"
          ? "No automatic schedule is configured."
          : "Schedule recorded, but nothing fires it yet — see ADR-009 Decision 2.",
    },
  });
}

export const systemService = { information } as const;
