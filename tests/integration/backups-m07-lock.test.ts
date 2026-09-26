import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M07 review: what a restore does when ANOTHER restore holds the lock.
 *
 * The isolated database is one PostgreSQL session behind a multiplexer, so two
 * genuinely simultaneous transactions cannot be staged here. What can be
 * proven is the decision itself: with the advisory lock reported as held —
 * exactly what `pg_try_advisory_xact_lock` returns to the second of two
 * concurrent restores — the restore is refused before it writes a single
 * business row, and retention refuses to delete anything.
 *
 * LOCAL ONLY.
 */

const bucket = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("@/modules/backups/storage/backup-storage", () => {
  const ok = <T>(value: T) => ({ ok: true as const, value });
  return {
    BACKUP_BUCKET: "backups",
    backupStorage: {
      bucket: "backups",
      pathFor: (id: string) => `${id}.json.gz`,
      ensureBucket: async () => ok(true),
      upload: async (id: string, body: Buffer) => {
        bucket.set(`${id}.json.gz`, Buffer.from(body));
        return ok({ path: `${id}.json.gz` });
      },
      download: async (path: string) => ok(Buffer.from(bucket.get(path) ?? Buffer.alloc(0))),
      signedUrl: async (path: string) => ok(`memory://${path}`),
      remove: async (path: string) => {
        bucket.delete(path);
        return ok(true);
      },
    },
  };
});

/* Another restore is running: the lock is never available. */
vi.mock("@/modules/backups/repositories/dataset.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/backups/repositories/dataset.repository")>()),
  tryRestoreLock: async () => false,
}));

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;
const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

let admin: AppUser;

async function fingerprint(): Promise<string> {
  const rows = await sql!<{ digest: string }[]>`
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) as digest from accounts t
    union all
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from profiles t
    union all
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from users t`;
  return rows.map((row) => row.digest).join(",");
}

beforeAll(async () => {
  if (!local) return;
  const [row] = await sql!<{ id: string; name: string; email: string }[]>`
    select id, name, email from users where role = 'super_admin' and deleted_at is null limit 1`;
  admin = {
    id: row!.id,
    email: row!.email,
    displayName: row!.name,
    initials: "SA",
    role: "super_admin",
  };
  const { settingsRepository } = await import("@/modules/settings");
  await settingsRepository.ensureExists();
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe.skipIf(!local)("a second restore while one holds the lock", () => {
  it("is refused as a conflict, before any business row changes", async () => {
    const { backupService, restoreService } = await services();
    const created = await backupService.create({ type: "manual" }, { actor: admin });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const { accountsService } = await import("@/modules/accounts");
    await accountsService.createAccount(
      {
        email: `lock-${Date.now()}@example.invalid`,
        password: "not-real",
        country: "DZ",
        profileSlots: 5,
      },
      { actor: admin },
    );
    const before = await fingerprint();

    const restored = await restoreService.restore(
      created.value.id,
      { confirmation: "RESTORE", expectedChecksum: created.value.checksum! },
      { actor: admin },
    );

    expect(restored.ok).toBe(false);
    if (!restored.ok) {
      expect(restored.error.code).toBe("CONFLICT");
      expect(restored.error.userMessage).toMatch(/Another restore is already running/);
    }
    expect(await fingerprint()).toEqual(before);
  });

  it("retention deletes nothing while the lock is held", async () => {
    const { backupsRepository } = await import("@/modules/backups/repositories/backups.repository");
    const { backupService } = await services();
    const created = await backupService.create({ type: "manual" }, { actor: admin });
    if (!created.ok) throw new Error(created.error.message);

    const deleted = await backupsRepository.deleteMany([created.value.id]);

    expect(deleted.ok && deleted.value).toBeNull();
    const [{ n } = { n: -1 }] = await sql!<{ n: number }[]>`
      select count(*)::int n from backups where id = ${created.value.id}::uuid`;
    expect(n).toBe(1);
  });
});

async function services() {
  const { backupService, restoreService } = await import("@/modules/backups");
  return { backupService, restoreService };
}
