import { gunzipSync, gzipSync } from "node:zlib";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M07 backups, end to end, against the isolated database.
 *
 * The real engine — snapshot reads, the v2 artifact, verification, import,
 * preview with its rehearsal, the confirmed restore, retention and the
 * scheduler — with one stand-in: Supabase Storage, which isolated mode cannot
 * reach, is replaced by an in-memory bucket. Everything that touches the
 * database is the production code path.
 *
 * LOCAL ONLY.
 */

/* ---------------------------------------------------- in-memory storage */

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
      download: async (path: string) => {
        const body = bucket.get(path);
        if (!body) {
          const { NotFoundError } = await import("@/lib/errors");
          return { ok: false as const, error: new NotFoundError(`missing ${path}`) };
        }
        return ok(Buffer.from(body));
      },
      signedUrl: async (path: string) => ok(`memory://${path}`),
      remove: async (path: string) => {
        bucket.delete(path);
        return ok(true);
      },
    },
  };
});

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;
const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

const PLAIN_PASSWORD = "Plain-Account-Password-M07!";
const PIN = "8631";
const TAG = `m07${Date.now() % 100000}`;

let admin: AppUser;
let worker: AppUser;

async function services() {
  const { backupService, restoreService, backupScheduler } = await import("@/modules/backups");
  const { accountsService } = await import("@/modules/accounts");
  const { problemsService } = await import("@/modules/problems");
  const { checksumService } = await import("@/modules/backups/services/checksum.service");
  return {
    backupService,
    restoreService,
    backupScheduler,
    accountsService,
    problemsService,
    checksumService,
  };
}

async function makeAccount(label: string): Promise<string> {
  const { accountsService } = await services();
  const created = await accountsService.createAccount(
    {
      email: `${TAG}-${label}@example.invalid`,
      password: PLAIN_PASSWORD,
      country: "DZ",
      profileSlots: 5,
    },
    { actor: admin },
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value.id;
}

async function report(accountId: string): Promise<string> {
  const { problemsService } = await services();
  const created = await problemsService.report(
    { accountId, issueType: "payment_problem", description: "card declined" },
    { actor: worker },
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value.id;
}

async function backup(type: "manual" | "snapshot" = "manual") {
  const { backupService } = await services();
  const created = await backupService.create({ type }, { actor: admin });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

function artifactOf(filename: string) {
  return JSON.parse(gunzipSync(bucket.get(filename)!).toString("utf8")) as {
    manifest: Record<string, unknown>;
    data: Record<string, Record<string, unknown>[]>;
    rowCounts: Record<string, number>;
    contentSha256?: string;
  };
}

/** Stores a hand-made artifact as a completed backup, exactly as import would. */
async function storeCrafted(document: unknown): Promise<{ id: string; checksum: string }> {
  const { checksumService } = await services();
  const body = gzipSync(Buffer.from(JSON.stringify(document)));
  const checksum = checksumService.of(body);
  const [row] = await sql!<{ id: string }[]>`
    insert into backups (name, type, status, filename, checksum, size_bytes, completed_at, format_version)
    values (${`crafted-${Date.now()}`}, 'manual', 'completed', 'pending', ${checksum}, ${body.byteLength}, now(), 2)
    returning id`;
  const filename = `${row!.id}.json.gz`;
  await sql!`update backups set filename = ${filename} where id = ${row!.id}::uuid`;
  bucket.set(filename, body);
  return { id: row!.id, checksum };
}

/** A consistent v2 document from a stored backup, with the data edited, hash and counts recomputed. */
async function edited(
  filename: string,
  edit: (data: Record<string, Record<string, unknown>[]>) => void,
  options: { keepHash?: boolean } = {},
) {
  const { checksumService } = await services();
  const document = artifactOf(filename);
  const data = structuredClone(document.data);
  edit(data);
  const tables = document.manifest["tables"] as string[];
  const rowCounts = Object.fromEntries(tables.map((table) => [table, data[table]?.length ?? 0]));
  return {
    manifest: {
      ...document.manifest,
      rowCounts,
      contentSha256: options.keepHash
        ? document.contentSha256
        : checksumService.contentSha256(tables, data),
    },
    data,
  };
}

async function count(table: string): Promise<number> {
  const [row] = await sql!<{ n: number }[]>`select count(*)::int n from ${sql!(table)}`;
  return row!.n;
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of [
    "users",
    "customers",
    "accounts",
    "profiles",
    "issues",
    "issue_notes",
    "notifications",
    "report_presets",
    "audit_logs",
  ]) {
    out[table] = await count(table);
  }
  return out;
}

async function setBackupSettings(value: Record<string, unknown>) {
  await sql!`
    update settings set values = jsonb_set(coalesce(values, '{}'::jsonb), '{backup}', ${sql!.json(value as never)})`;
}

let baseId: string;
let baseChecksum: string;
let fixtureAccount: string;

beforeAll(async () => {
  if (!local) return;

  const rows = await sql!<{ id: string; name: string; email: string; role: string }[]>`
    select id, name, email, role from users where status = 'active' and deleted_at is null`;
  const a = rows.find((row) => row.role === "super_admin")!;
  const w = rows.find((row) => row.role === "worker")!;
  admin = { id: a.id, email: a.email, displayName: a.name, initials: "SA", role: "super_admin" };
  worker = { id: w.id, email: w.email, displayName: w.name, initials: "W", role: "worker" };

  /* Every table M01–M06 created gets at least one row. */
  const { settingsRepository } = await import("@/modules/settings");
  await settingsRepository.ensureExists();

  fixtureAccount = await makeAccount("fixture");
  await sql!`update profiles set pin = ${PIN}, profile_name = 'Kids' where account_id = ${fixtureAccount}::uuid and profile_number = 1`;
  const issue = await report(fixtureAccount);
  await sql!`insert into issue_notes (issue_id, user_id, body) values (${issue}::uuid, ${admin.id}::uuid, 'first note')`;
  await sql!`insert into report_presets (user_id, report, name) values (${admin.id}::uuid, 'accounts', ${`${TAG} preset`})`;
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/* ------------------------------------------------------------ authorization */

describe.skipIf(!local)("authorization: Super Admin only, checked before anything", () => {
  it.each([
    ["a Worker", () => worker],
    ["the signed-out", () => null],
  ])("%s is refused every operation", async (_label, who) => {
    const { backupService, restoreService } = await services();
    const actor = who() as AppUser | null;
    const context = { actor };
    const id = "00000000-0000-4000-8000-000000000000";
    const results = await Promise.all([
      backupService.list({}, actor),
      backupService.summary(actor),
      backupService.create({ type: "manual" }, context),
      backupService.verify(id, context),
      backupService.exportUrl(id, actor),
      backupService.importArtifact(Buffer.from("x"), context),
      backupService.readSettings(actor),
      restoreService.preview(id, actor),
      restoreService.restore(
        id,
        { confirmation: "RESTORE", expectedChecksum: "0".repeat(64) },
        context,
      ),
    ]);

    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    }
  });
});

/* --------------------------------------------------------- backup creation */

describe.skipIf(!local)("a backup", () => {
  it("captures every business table, in format 2, from one snapshot", async () => {
    const created = await backup();
    const document = artifactOf(created.filename!);
    const live = await counts();

    expect(created.status).toBe("completed");
    expect(created.formatVersion).toBe(2);
    expect(document.manifest["formatVersion"]).toBe(2);
    expect(document.manifest["schemaVersion"]).toBe(
      await count("drizzle.__drizzle_migrations").catch(() => 15),
    );
    expect(Object.keys(document.data)).toEqual([
      "users",
      "customers",
      "accounts",
      "profiles",
      "profile_events",
      "issues",
      "issue_notes",
      "notifications",
      "report_presets",
      "audit_logs",
      "settings",
    ]);
    for (const table of [
      "users",
      "customers",
      "accounts",
      "profiles",
      "issues",
      "issue_notes",
      "notifications",
      "report_presets",
    ]) {
      expect(document.rowCounts[table], table).toBe(live[table]);
      expect(live[table], table).toBeGreaterThan(0);
    }
    expect(created.tableCounts).toEqual(document.rowCounts);
  });

  it("carries a content hash anyone can recompute", async () => {
    const { checksumService } = await services();
    const created = await backup();
    const document = artifactOf(created.filename!);

    expect(document.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      checksumService.contentSha256(document.manifest["tables"] as string[], document.data),
    ).toBe(document.contentSha256);
  });

  it("is deterministic: unchanged data gives the same content hash", async () => {
    const { checksumService } = await services();
    const first = artifactOf((await backup()).filename!);
    const second = artifactOf((await backup()).filename!);
    /*
     * Taking a backup writes its own audit row, so audit_logs legitimately
     * differs between the two. Every other table is unchanged, and must hash
     * — and serialise — identically.
     */
    const tables = (first.manifest["tables"] as string[]).filter((table) => table !== "audit_logs");

    expect(checksumService.contentSha256(tables, second.data)).toBe(
      checksumService.contentSha256(tables, first.data),
    );
    for (const table of tables) {
      expect(JSON.stringify(second.data[table]), table).toBe(JSON.stringify(first.data[table]));
    }
  });

  it("holds credentials only as the stored ciphertext, and nothing from the environment", async () => {
    const text = gunzipSync(bucket.get((await backup()).filename!)!).toString("utf8");

    expect(text).not.toContain(PLAIN_PASSWORD);
    expect(text).toMatch(/"password_encrypted":"v1:/);
    for (const key of [
      "ENCRYPTION_KEY",
      "DATABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "CRON_SECRET",
    ]) {
      const value = process.env[key];
      if (value && value.length > 8) expect(text, key).not.toContain(value);
    }
  });

  it("is audited without its payload", async () => {
    const created = await backup();
    const [row] = await sql!<{ after: Record<string, unknown> }[]>`
      select after from audit_logs where entity = 'backup' and entity_id = ${created.id}::uuid and action = 'create'`;
    const body = JSON.stringify(row?.after);

    expect(row).toBeDefined();
    expect(body).not.toMatch(/"data"|"manifest"|password_encrypted/);
    expect(body).not.toContain(PIN);
  });
});

/* ---------------------------------------------------------------- integrity */

describe.skipIf(!local)("integrity: a changed backup is refused", () => {
  it("verify accepts an intact backup", async () => {
    const { backupService } = await services();
    const created = await backup();

    const verified = await backupService.verify(created.id, { actor: admin });

    expect(verified.ok && verified.value.status).toBe("verified");
  });

  it("a changed file fails its checksum: verify and restore both refuse", async () => {
    const { backupService, restoreService } = await services();
    const created = await backup();
    const body = bucket.get(created.filename!)!;
    bucket.set(created.filename!, Buffer.concat([body, Buffer.from([0])]));

    const verified = await backupService.verify(created.id, { actor: admin });
    const previewed = await restoreService.preview(created.id, admin);

    expect(verified.ok).toBe(false);
    expect(previewed.ok).toBe(false);
  });

  it("edited data with a recomputed file checksum fails the content hash", async () => {
    const { restoreService } = await services();
    const source = await backup();
    const document = await edited(
      source.filename!,
      (data) => {
        data["accounts"]![0]!["email"] = "attacker@example.invalid";
      },
      { keepHash: true },
    );
    const crafted = await storeCrafted(document);

    const previewed = await restoreService.preview(crafted.id, admin);

    expect(previewed.ok).toBe(false);
    if (!previewed.ok) expect(previewed.error.userMessage).toMatch(/content hash/);
  });

  it("import refuses garbage, a newer format, and a v2 file without its hash", async () => {
    const { backupService } = await services();
    const source = await backup();
    const good = artifactOf(source.filename!);
    const gz = (value: unknown) => gzipSync(Buffer.from(JSON.stringify(value)));

    const garbage = await backupService.importArtifact(Buffer.from("not a backup"), {
      actor: admin,
    });
    const newer = await backupService.importArtifact(
      gz({ ...good, manifest: { ...good.manifest, formatVersion: 99 } }),
      { actor: admin },
    );
    const noHash = await backupService.importArtifact(
      gz({ manifest: good.manifest, data: good.data, rowCounts: good.rowCounts }),
      {
        actor: admin,
      },
    );

    expect(garbage.ok).toBe(false);
    expect(newer.ok).toBe(false);
    expect(noHash.ok).toBe(false);
  });

  it("import refuses an edited file and accepts the original, as a restore point", async () => {
    const { backupService } = await services();
    const source = await backup();
    const good = artifactOf(source.filename!);
    const tampered = structuredClone(good);
    tampered.data["customers"]![0]!["name"] = "Changed";

    const refused = await backupService.importArtifact(
      gzipSync(Buffer.from(JSON.stringify(tampered))),
      {
        actor: admin,
      },
    );
    const accepted = await backupService.importArtifact(bucket.get(source.filename!)!, {
      actor: admin,
    });

    expect(refused.ok).toBe(false);
    expect(accepted.ok && accepted.value.isRestorePoint).toBe(true);
  });
});

/* ------------------------------------------------------------------ restore */

describe.skipIf(!local)("restore", () => {
  let later: { account: string; issue: string };

  beforeAll(async () => {
    if (!local) return;
    const base = await backup();
    baseId = base.id;
    baseChecksum = base.checksum!;

    /* Everything that happens after the backup. */
    later = { account: await makeAccount("later"), issue: "" };
    later.issue = await report(fixtureAccount);
    await sql!`update accounts set notes = 'edited after the backup' where id = ${fixtureAccount}::uuid`;
  });

  it("previews by rehearsing, and the rehearsal changes nothing", async () => {
    const { restoreService } = await services();
    const before = await counts();

    const previewed = await restoreService.preview(baseId, admin);

    expect(previewed.ok, previewed.ok ? "" : previewed.error.message).toBe(true);
    if (!previewed.ok) return;
    expect(previewed.value).toMatchObject({
      rehearsed: true,
      contentVerified: true,
      checksum: baseChecksum,
    });

    const accounts = previewed.value.effects.tables.find((entry) => entry.table === "accounts");
    const issues = previewed.value.effects.tables.find((entry) => entry.table === "issues");
    expect(accounts).toEqual({
      table: "accounts",
      before: before["accounts"],
      after: before["accounts"]! - 1,
    });
    expect(issues?.after).toBe(before["issues"]! - 1);

    expect(await counts()).toEqual(before);
  });

  it("refuses without the typed confirmation, or for a different file", async () => {
    const { restoreService } = await services();
    const before = await counts();

    const unconfirmed = await restoreService.restore(
      baseId,
      { confirmation: "yes", expectedChecksum: baseChecksum },
      { actor: admin },
    );
    const otherFile = await restoreService.restore(
      baseId,
      { confirmation: "RESTORE", expectedChecksum: "f".repeat(64) },
      { actor: admin },
    );

    expect(unconfirmed.ok).toBe(false);
    expect(otherFile.ok).toBe(false);
    if (!otherFile.ok) expect(otherFile.error.code).toBe("CONFLICT");
    expect(await counts()).toEqual(before);
  });

  it("restores exactly, keeps its evidence, snapshots first and protects the source", async () => {
    const { restoreService } = await services();
    const auditBefore = await count("audit_logs");

    const restored = await restoreService.restore(
      baseId,
      { confirmation: "RESTORE", expectedChecksum: baseChecksum },
      { actor: admin },
    );

    expect(restored.ok, restored.ok ? "" : restored.error.message).toBe(true);
    if (!restored.ok) return;

    const [gone] = await sql!<
      { n: number }[]
    >`select count(*)::int n from accounts where id = ${later.account}::uuid`;
    const [issueGone] = await sql!<
      { n: number }[]
    >`select count(*)::int n from issues where id = ${later.issue}::uuid`;
    const [notes] = await sql!<
      { notes: string | null }[]
    >`select notes from accounts where id = ${fixtureAccount}::uuid`;
    expect(gone?.n).toBe(0);
    expect(issueGone?.n).toBe(0);
    expect(notes?.notes).not.toBe("edited after the backup");

    /* The evidence: audit_logs is append-only in a restore, so nothing was lost and both events exist. */
    expect(await count("audit_logs")).toBeGreaterThan(auditBefore);
    const events = await sql!<{ event: string }[]>`
      select after->>'event' as event from audit_logs
      where entity = 'backup' and entity_id = ${baseId}::uuid and action = 'restore' order by created_at`;
    expect(events.map((row) => row.event)).toEqual(["restore_started", "restored"]);

    const [source] = await sql!<
      { is_restore_point: boolean }[]
    >`select is_restore_point from backups where id = ${baseId}::uuid`;
    expect(source?.is_restore_point).toBe(true);
    expect(restored.value.safetySnapshotId).toMatch(/^[0-9a-f-]{36}$/);
    const [snapshot] = await sql!<{ type: string; status: string }[]>`
      select type::text, status::text from backups where id = ${restored.value.safetySnapshotId}::uuid`;
    expect(snapshot).toEqual({ type: "snapshot", status: "completed" });
  });

  it("a backup the database rejects fails the rehearsal and the restore, and changes nothing", async () => {
    const { restoreService } = await services();
    /* Two live customers with one phone: structurally fine, refused by a unique index. */
    const document = await edited((await backup()).filename!, (data) => {
      const customers = data["customers"]!;
      customers.push({ ...customers[0]!, id: "0e070000-0000-4000-8000-000000000001" });
    });
    const crafted = await storeCrafted(document);
    const before = await counts();
    const snapshotsBefore = await sql!<
      { n: number }[]
    >`select count(*)::int n from backups where type = 'snapshot'`;

    const previewed = await restoreService.preview(crafted.id, admin);
    const restored = await restoreService.restore(
      crafted.id,
      { confirmation: "RESTORE", expectedChecksum: crafted.checksum },
      { actor: admin },
    );

    expect(previewed.ok).toBe(false);
    if (!previewed.ok)
      expect(previewed.error.userMessage).toMatch(
        /rehearsed[\s\S]*refused[\s\S]*Nothing was changed/,
      );
    expect(restored.ok).toBe(false);
    if (!restored.ok)
      expect(restored.error.userMessage).toMatch(/rolled back — nothing was changed/);

    /* The restore took its safety snapshot, then rolled back: business data identical. */
    const after = await counts();
    expect({ ...after, audit_logs: 0 }).toEqual({ ...before, audit_logs: 0 });
    const [snapshotsAfter] = await sql!<
      { n: number }[]
    >`select count(*)::int n from backups where type = 'snapshot'`;
    expect(snapshotsAfter!.n).toBe(snapshotsBefore[0]!.n + 1);

    const [failed] = await sql!<{ event: string; reason: string }[]>`
      select after->>'event' as event, after->>'reason' as reason from audit_logs
      where entity = 'backup' and entity_id = ${crafted.id}::uuid and action = 'restore'
      order by created_at desc limit 1`;
    expect(failed?.event).toBe("restore_failed");
  });

  it("an inconsistent backup is refused before anything — not even a snapshot", async () => {
    const { restoreService } = await services();
    const document = await edited((await backup()).filename!, (data) => {
      data["profiles"]![0]!["account_id"] = "0e070000-0000-4000-8000-0000000000ff";
    });
    const crafted = await storeCrafted(document);
    const [{ n: snapshotsBefore } = { n: -1 }] = await sql!<
      { n: number }[]
    >`select count(*)::int n from backups where type = 'snapshot'`;

    const restored = await restoreService.restore(
      crafted.id,
      { confirmation: "RESTORE", expectedChecksum: crafted.checksum },
      { actor: admin },
    );

    expect(restored.ok).toBe(false);
    if (!restored.ok) expect(restored.error.userMessage).toMatch(/not consistent/);
    const [{ n: snapshotsAfter } = { n: -1 }] = await sql!<
      { n: number }[]
    >`select count(*)::int n from backups where type = 'snapshot'`;
    expect(snapshotsAfter).toBe(snapshotsBefore);
  });

  it("an older (v1) backup leaves tables it lacks alone, except what cascades — and says so first", async () => {
    const { restoreService } = await services();
    const source = artifactOf((await backup()).filename!);
    const v1Tables = [
      "users",
      "customers",
      "accounts",
      "profiles",
      "profile_events",
      "audit_logs",
      "settings",
    ];
    const v1 = {
      manifest: {
        ...source.manifest,
        formatVersion: 1,
        schemaVersion: undefined,
        contentSha256: undefined,
        tables: v1Tables,
      },
      data: Object.fromEntries(v1Tables.map((table) => [table, source.data[table]])),
      rowCounts: Object.fromEntries(v1Tables.map((table) => [table, source.rowCounts[table]])),
    };
    const crafted = await storeCrafted(v1);
    await sql!`update backups set format_version = 1 where id = ${crafted.id}::uuid`;

    /* After the v1 backup: a new account with a problem, and a problem on an account the backup has. */
    const newAccount = await makeAccount("after-v1");
    const onNew = await report(newAccount);
    const onExisting = await report(fixtureAccount);
    const issuesBefore = await count("issues");

    const previewed = await restoreService.preview(crafted.id, admin);

    expect(previewed.ok, previewed.ok ? "" : previewed.error.message).toBe(true);
    if (!previewed.ok) return;
    expect(previewed.value.contentVerified).toBe(false);
    expect(previewed.value.warnings.join(" ")).toMatch(/version 1/);
    expect(previewed.value.effects.tables.find((entry) => entry.table === "issues")).toEqual({
      table: "issues",
      before: issuesBefore,
      after: issuesBefore - 1,
    });

    const restored = await restoreService.restore(
      crafted.id,
      { confirmation: "RESTORE", expectedChecksum: crafted.checksum },
      { actor: admin },
    );
    expect(restored.ok, restored.ok ? "" : restored.error.message).toBe(true);

    const survivors = await sql!<{ id: string }[]>`
      select id from issues where id in (${onNew}::uuid, ${onExisting}::uuid)`;
    /* Before M07 the absent table was emptied; now only the cascaded row goes. */
    expect(survivors.map((row) => row.id)).toEqual([onExisting]);
  });
});

/* ---------------------------------------------------------------- retention */

describe.skipIf(!local)("retention", () => {
  it("keeps the configured number of routine backups, never restore points, snapshots or failures", async () => {
    await setBackupSettings({ retention: { keepLast: 1 } });
    await sql!`
      insert into backups (name, type, status, error_message) values ('failed-for-retention', 'manual', 'failed', 'x')`;

    const newest = await backup();

    const routine = await sql!<{ id: string }[]>`
      select id from backups where status in ('completed', 'verified')
        and not is_restore_point and type <> 'snapshot'`;
    const [{ n: protectedCount } = { n: -1 }] = await sql!<{ n: number }[]>`
      select count(*)::int n from backups where is_restore_point or type = 'snapshot'`;
    const [{ n: failed } = { n: -1 }] = await sql!<{ n: number }[]>`
      select count(*)::int n from backups where name = 'failed-for-retention'`;

    expect(routine.map((row) => row.id)).toEqual([newest.id]);
    expect(protectedCount).toBeGreaterThan(0);
    expect(failed).toBe(1);

    /* Pruned rows were audited as deletions, and their files removed. */
    const [{ n: deletions } = { n: -1 }] = await sql!<{ n: number }[]>`
      select count(*)::int n from audit_logs where entity = 'backup' and action = 'delete'`;
    expect(deletions).toBeGreaterThan(0);
    await setBackupSettings({ retention: { keepLast: 30 } });
  });
});

/* ---------------------------------------------------------------- scheduler */

describe.skipIf(!local)("the scheduler", () => {
  it("does nothing while the schedule is off", async () => {
    const { backupScheduler } = await services();
    await setBackupSettings({
      schedule: { frequency: "off", hourUtc: 2 },
      retention: { keepLast: 30 },
    });

    const tick = await backupScheduler.tick(new Date());

    expect(tick.ok && tick.value.reason).toBe("schedule_off");
  });

  it("runs one daily backup per slot, as the system, and not again in the same slot", async () => {
    const { backupScheduler } = await services();
    await setBackupSettings({
      schedule: { frequency: "daily", hourUtc: 0 },
      retention: { keepLast: 30 },
    });
    const now = new Date();

    const first = await backupScheduler.tick(now);
    const second = await backupScheduler.tick(new Date(now.getTime() + 60_000));

    expect(first.ok && first.value.reason).toBe("completed");
    expect(second.ok && second.value.reason).toBe("not_due");

    const backupId = first.ok ? first.value.backupId : undefined;
    const [row] = await sql!<{ type: string; created_by: string | null }[]>`
      select type::text, created_by from backups where id = ${backupId!}::uuid`;
    expect(row).toEqual({ type: "daily", created_by: null });
    const [audit] = await sql!<{ user_id: string | null }[]>`
      select user_id from audit_logs where entity = 'backup' and entity_id = ${backupId!}::uuid and action = 'create'`;
    expect(audit?.user_id).toBeNull();
  });

  it("stands down while a backup is running, and fails one that was abandoned", async () => {
    const { backupScheduler } = await services();
    const [{ id: fresh } = { id: "" }] = await sql!<{ id: string }[]>`
      insert into backups (name, type, status) values ('running-now', 'manual', 'running') returning id`;

    /* The running check comes before the due check, so "now" is enough. */
    const busy = await backupScheduler.tick(new Date());
    expect(busy.ok && busy.value.reason).toBe("already_running");

    await sql!`update backups set created_at = now() - interval '2 hours' where id = ${fresh}::uuid`;
    const healed = await backupScheduler.tick(new Date());
    expect(healed.ok && healed.value.interruptedMarkedFailed).toBe(1);
    const [row] = await sql!<{ status: string; error_message: string }[]>`
      select status::text, error_message from backups where id = ${fresh}::uuid`;
    expect(row?.status).toBe("failed");
    expect(row?.error_message).toMatch(/^Interrupted/);

    await setBackupSettings({
      schedule: { frequency: "off", hourUtc: 2 },
      retention: { keepLast: 30 },
    });
  });
});

/* ------------------------------------------------------ the format vs the schema */

describe.skipIf(!local)("the format stays in step with the schema", () => {
  it("backs up every public table except the deliberate exclusions", async () => {
    const { BACKUP_TABLE_NAMES, EXCLUDED_TABLES } =
      await import("@/modules/backups/services/backup-format");
    const tables = await sql!<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`;

    expect(tables.map((row) => row.table_name).sort()).toEqual(
      [...BACKUP_TABLE_NAMES, ...EXCLUDED_TABLES].sort(),
    );
  });

  it("declares exactly the foreign keys the database has between backed-up tables", async () => {
    const { BACKUP_TABLE_NAMES, RELATIONSHIPS } =
      await import("@/modules/backups/services/backup-format");
    const keys = await sql!<{ child: string; col: string; parent: string; nullable: boolean }[]>`
      select c.conrelid::regclass::text child, a.attname col, c.confrelid::regclass::text parent,
             not a.attnotnull as nullable
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace`;
    const catalog = keys
      .filter(
        (key) => BACKUP_TABLE_NAMES.includes(key.child) && BACKUP_TABLE_NAMES.includes(key.parent),
      )
      .map((key) => `${key.child}.${key.col}->${key.parent}:${key.nullable}`)
      .sort();

    expect(
      RELATIONSHIPS.map(
        (rel) => `${rel.table}.${rel.column}->${rel.parent}:${rel.nullable}`,
      ).sort(),
    ).toEqual(catalog);
  });
});
