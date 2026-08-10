import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { ForbiddenError } from "@/lib/errors";
import { BACKUP_TABLE_NAMES } from "@/modules/backups";

/**
 * Backup module integration tests, against the real database.
 *
 * Read-and-create only. Nothing here restores: a restore rewrites every business
 * table, and a test that did it against the live project would be the disaster
 * the module exists to recover from. Restore is exercised up to and including
 * the preview, which is the step that reads the artifact, verifies its checksum
 * and computes every change — everything except applying them.
 *
 * Creating a backup is safe: it only reads business data and writes one row plus
 * one storage object.
 *
 * Skipped automatically when no real project is configured.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");
const storageConfigured = Boolean(process.env["SUPABASE_SERVICE_ROLE_KEY"]);

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 2 }) : null;

let superAdmin: AppUser;

const WORKER: AppUser = {
  id: "00000000-0000-0000-0000-0000000000bb",
  email: "worker@example.invalid",
  displayName: "Worker",
  initials: "WK",
  role: "worker",
};

beforeAll(async () => {
  if (!configured) {
    return;
  }

  const rows = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users
    where role = 'super_admin' and status = 'active' and deleted_at is null limit 1
  `;

  const row = rows[0];

  if (!row) {
    throw new Error("No active Super Admin to authorize as");
  }

  superAdmin = {
    id: row.id,
    email: row.email,
    displayName: row.name,
    initials: "SA",
    role: "super_admin",
  };
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function services() {
  const { backupService } = await import("@/modules/backups/services/backup.service");
  const { restoreService } = await import("@/modules/backups/services/restore.service");
  return { backupService, restoreService };
}

describe.skipIf(!configured)("backup schema — migration 0007 applied", () => {
  it("has every column the Backup Details screen reads", async () => {
    const rows = await sql!<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'backups'
    `;

    const columns = new Set(rows.map((row) => row.column_name));

    for (const required of [
      "name",
      "format_version",
      "app_version",
      "database_version",
      "table_counts",
      "checksum",
      "size_bytes",
      "is_restore_point",
    ]) {
      expect(columns.has(required), `backups.${required} is missing`).toBe(true);
    }
  });

  it("offers every backup type the module can produce", async () => {
    const rows = await sql!<{ label: string }[]>`
      select enumlabel as label from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'backup_type'
    `;

    const labels = new Set(rows.map((row) => row.label));

    /* Hourly survives from four LOCKED documents; the rest come from M07. */
    for (const value of ["hourly", "daily", "weekly", "monthly", "manual", "snapshot"]) {
      expect(labels.has(value), `backup_type is missing "${value}"`).toBe(true);
    }
  });

  it("keeps every backed-up table present in the database", async () => {
    const rows = await sql!<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public'
    `;

    const tables = new Set(rows.map((row) => row.table_name));

    for (const table of BACKUP_TABLE_NAMES) {
      expect(tables.has(table), `backup references missing table "${table}"`).toBe(true);
    }
  });

  it("still restricts backups to Super Admins at the database level", async () => {
    const rows = await sql!<{ policyname: string; qual: string }[]>`
      select policyname, qual::text as qual from pg_policies
      where schemaname = 'public' and tablename = 'backups'
    `;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.qual.includes("is_super_admin"))).toBe(true);
  });
});

describe.skipIf(!configured)("RBAC — a Worker cannot reach any backup operation", () => {
  it("cannot list", async () => {
    const { backupService } = await services();
    const result = await backupService.list({ limit: 5, offset: 0 }, WORKER);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("cannot create", async () => {
    const { backupService } = await services();
    const result = await backupService.create({ type: "manual" }, { actor: WORKER });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("cannot preview a restore", async () => {
    const { restoreService } = await services();
    const result = await restoreService.preview("00000000-0000-0000-0000-000000000000", WORKER);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("cannot restore", async () => {
    const { restoreService } = await services();
    const result = await restoreService.restore("00000000-0000-0000-0000-000000000000", {
      actor: WORKER,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("is refused with no actor at all", async () => {
    const { backupService } = await services();
    const result = await backupService.list({ limit: 5, offset: 0 }, null);

    expect(result.ok).toBe(false);
  });
});

describe.skipIf(!configured)("Super Admin reads", () => {
  it("lists backups with the creator resolved", async () => {
    const { backupService } = await services();
    const result = await backupService.list({ limit: 25, offset: 0 }, superAdmin);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      for (const entry of result.value.items) {
        expect(typeof entry.backup.id).toBe("string");
        expect(entry.backup.createdAt).toBeInstanceOf(Date);
      }
    }
  });

  it("reads the schedule and retention policy", async () => {
    const { backupService } = await services();
    const result = await backupService.readSettings(superAdmin);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      expect(["off", "hourly", "daily", "weekly", "monthly"]).toContain(
        result.value.schedule.frequency,
      );
      expect(result.value.retention.keepLast).toBeGreaterThan(0);
    }
  });
});

/**
 * The end-to-end path, gated on storage being configured.
 *
 * Creates a real backup, verifies its checksum by reading it back, and previews
 * a restore of it. The preview against a backup of the current state is the
 * strongest assertion available without applying anything: every table's diff
 * must be empty, because nothing changed between the backup and the preview.
 */
describe.skipIf(!configured || !storageConfigured)("backup, verify and preview", () => {
  let backupId: string | null = null;

  it("creates a real backup and records what it contains", async () => {
    const { backupService } = await services();

    const result = await backupService.create({ type: "manual" }, { actor: superAdmin });

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      backupId = result.value.id;

      expect(result.value.status).toBe("completed");
      expect(result.value.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(result.value.sizeBytes).toBeGreaterThan(0);
      expect(result.value.filename).toBeTruthy();

      const counts = result.value.tableCounts as Record<string, number>;

      for (const table of BACKUP_TABLE_NAMES) {
        expect(counts[table], `no row count recorded for ${table}`).toBeTypeOf("number");
      }

      /* The backup must actually contain the users it was taken from. */
      expect(counts["users"]).toBeGreaterThan(0);
    }
  }, 120_000);

  it("verifies the stored artifact against its checksum", async () => {
    expect(backupId).not.toBeNull();

    const { backupService } = await services();
    const result = await backupService.verify(backupId!, { actor: superAdmin });

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
    if (result.ok) expect(result.value.status).toBe("verified");
  }, 120_000);

  it("previews a restore of the state it was taken from as a no-op", async () => {
    expect(backupId).not.toBeNull();

    const { restoreService } = await services();
    const result = await restoreService.preview(backupId!, superAdmin);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      expect(result.value.checksumVerified).toBe(true);

      /*
       * Nothing changed between taking the backup and previewing it, so a
       * correct diff is empty. A non-zero number here means the round trip
       * through JSON altered a value — the failure mode that silently corrupts
       * data on a real restore.
       */
      expect(result.value.totals.create).toBe(0);
      expect(result.value.totals.update).toBe(0);
      expect(result.value.totals.delete).toBe(0);
      expect(result.value.conflicts).toEqual([]);
    }
  }, 120_000);

  it("refuses to restore a backup whose checksum no longer matches", async () => {
    expect(backupId).not.toBeNull();

    /*
     * Corrupts only the recorded checksum, never the stored file, and puts the
     * real one back afterwards. An earlier version left the bogus value in
     * place, which marked every backup this suite created permanently
     * unrestorable — a test that destroys the artifact it verifies.
     */
    const before = await sql!<{ checksum: string }[]>`
      select checksum from public.backups where id = ${backupId!}::uuid
    `;

    const original = before[0]?.checksum;
    expect(original).toBeTruthy();

    try {
      await sql!`
        update public.backups set checksum = repeat('0', 64) where id = ${backupId!}::uuid
      `;

      const { restoreService } = await services();
      const result = await restoreService.preview(backupId!, superAdmin);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("Checksum mismatch");
    } finally {
      await sql!`
        update public.backups
        set checksum = ${original!}, status = 'verified', error_message = null
        where id = ${backupId!}::uuid
      `;
    }
  }, 120_000);

  it("leaves the backup restorable after the corruption test", async () => {
    expect(backupId).not.toBeNull();

    const { restoreService } = await services();
    const result = await restoreService.preview(backupId!, superAdmin);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
    if (result.ok) expect(result.value.checksumVerified).toBe(true);
  }, 120_000);
});
