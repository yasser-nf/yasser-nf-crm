import { readFileSync, existsSync, readdirSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import * as schema from "@/lib/drizzle/schema";

/**
 * The migration history and its metadata, checked without touching production.
 *
 * M01 finding F3: 13 migrations but only 7 snapshots, so `drizzle-kit generate`
 * diffed today's schema against the 0006 snapshot and stopped at an interactive
 * "created or renamed?" prompt — where a wrong answer emits DROP COLUMN. M01.5
 * installed a 0012 baseline snapshot taken from the TypeScript schema.
 *
 * These tests keep it that way. The strongest is the snapshot-equality check:
 * if the latest snapshot equals a snapshot freshly generated from the schema,
 * `generate` has nothing to diff, so it cannot propose anything destructive.
 * Change the schema without generating a migration and it fails.
 *
 * Everything that needs a database uses the in-process PGlite from
 * tests/support/isolated-database.mjs. Nothing here can reach production.
 */

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
}

interface Snapshot {
  readonly id: string;
  readonly prevId: string;
  readonly [key: string]: unknown;
}

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
  entries: JournalEntry[];
};

const snapshotFiles = readdirSync("drizzle/meta")
  .filter((file) => file.endsWith("_snapshot.json"))
  .sort();

const readSnapshot = (file: string) =>
  JSON.parse(readFileSync(`drizzle/meta/${file}`, "utf8")) as Snapshot;

describe("migration metadata is coherent", () => {
  it("has a .sql file for every journal entry", () => {
    for (const entry of journal.entries) {
      expect(existsSync(`drizzle/${entry.tag}.sql`), entry.tag).toBe(true);
    }
  });

  it("numbers the journal contiguously from 0", () => {
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
  });

  it("orders journal timestamps strictly upward — the migrator applies by timestamp", () => {
    /*
     * drizzle's migrator applies every entry whose `when` is later than the last
     * one recorded in the database. An entry dated earlier than its predecessor
     * would be silently skipped on an existing database.
     */
    for (let index = 1; index < journal.entries.length; index += 1) {
      expect(journal.entries[index]!.when).toBeGreaterThan(journal.entries[index - 1]!.when);
    }
  });

  it("has a snapshot for the LATEST migration — the one generate diffs against", () => {
    const last = journal.entries.at(-1)!;
    const expected = `${String(last.idx).padStart(4, "0")}_snapshot.json`;

    expect(snapshotFiles.at(-1)).toBe(expected);
  });

  it("chains snapshots without a collision", () => {
    /* Two snapshots claiming the same parent is what `drizzle-kit check` rejects. */
    const snapshots = snapshotFiles.map(readSnapshot);
    const ids = new Set(snapshots.map((snapshot) => snapshot.id));
    const parents = snapshots.map((snapshot) => snapshot.prevId);

    expect(new Set(parents).size).toBe(parents.length);
    for (const snapshot of snapshots.slice(1)) {
      expect(ids.has(snapshot.prevId), `${snapshot.id} points at a missing parent`).toBe(true);
    }
  });

  it("gives every migration after 0002 a hand-written down file", () => {
    /* The repository convention (drizzle/down/README.md); 0002 is the RLS lockdown. */
    for (const entry of journal.entries.filter((e) => e.idx > 2)) {
      expect(existsSync(`drizzle/down/${entry.tag}.down.sql`), entry.tag).toBe(true);
    }
  });
});

describe("generate cannot propose a destructive change", () => {
  it("has a latest snapshot equal to a fresh snapshot of the TypeScript schema", async () => {
    const { generateDrizzleJson } = await import("drizzle-kit/api");

    const fresh = generateDrizzleJson(schema as unknown as Record<string, unknown>) as Record<
      string,
      unknown
    >;
    const latest = readSnapshot(snapshotFiles.at(-1)!);

    /* ids differ by construction; everything that describes the schema must not */
    for (const key of ["tables", "enums", "schemas", "sequences", "roles", "policies", "views"]) {
      expect(latest[key], key).toEqual(fresh[key]);
    }
  });
});

describe("the migration history replays from nothing", () => {
  let db: PGlite;

  beforeAll(async () => {
    const { createIsolatedDatabase } = await import("../support/isolated-database.mjs");
    db = await createIsolatedDatabase();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("applies every migration with drizzle's own migrator", async () => {
    const applied = await db.query<{ n: number }>(
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );

    expect(applied.rows[0]!.n).toBe(journal.entries.length);
  });

  /*
   * M05 added `notifications` (0014): twelve became thirteen. M10 added
   * `suppliers` (0016): fifteen became sixteen.
   */
  it("produces the sixteen application tables", async () => {
    const tables = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );

    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "accounts",
      "audit_logs",
      "backups",
      "customers",
      "idempotency_keys",
      "issue_notes",
      "issues",
      "jobs",
      "login_history",
      "notifications",
      "profile_events",
      "profiles",
      "report_presets",
      "settings",
      "suppliers",
      "users",
    ]);
  });

  /**
   * M10. The supplier relationship and its deletion behaviour.
   *
   * RESTRICT is the part worth pinning: cascade would delete accounts with
   * their supplier, and SET NULL would quietly turn them into ours — a rewrite
   * of history M10 §23 forbids. Neither mistake is visible in application code,
   * so it is asserted against the catalog.
   */
  it("links accounts to suppliers with ON DELETE RESTRICT", async () => {
    const fk = await db.query<{ confdeltype: string }>(
      `select confdeltype from pg_constraint
       where conname = 'accounts_supplier_id_suppliers_id_fk'`,
    );

    /* 'r' is RESTRICT; 'c' would be cascade and 'n' set null. */
    expect(fk.rows[0]?.confdeltype).toBe("r");
  });

  /** M10 §5: one supplier per name, however it was typed. */
  it("makes the normalized supplier name unique", async () => {
    const indexes = await db.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where tablename = 'suppliers' and indexdef like '%UNIQUE%'`,
    );

    expect(indexes.rows.map((row) => row.indexname)).toContain("suppliers_name_normalized_unique");
  });

  /** M10 §26: the table is locked down in the migration that creates it. */
  it("enables row level security on suppliers, with a read and a write policy", async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid = 'public.suppliers'::regclass",
    );

    expect(rls.rows[0]?.relrowsecurity).toBe(true);

    const policies = await db.query<{ policyname: string }>(
      "select policyname from pg_policies where tablename = 'suppliers' order by 1",
    );

    expect(policies.rows.map((row) => row.policyname)).toEqual([
      "suppliers_read",
      "suppliers_write",
    ]);
  });

  /**
   * M10 §31, asserted on the migration TEXT as well as on the catalog.
   *
   * "No historical ownership is invented" is a claim about what the migration
   * does NOT do, and the catalog cannot show an absence. A nullable column with
   * no default cannot touch an existing row — but a backfill statement added
   * later could, and would be invisible to every other test here.
   */
  it("backfills nothing: 0016 never writes to accounts", async () => {
    const { readFile } = await import("node:fs/promises");
    const migration = await readFile("drizzle/0016_suppliers.sql", "utf8");

    /* Strip the comment lines, which legitimately contain the word UPDATE. */
    const statements = migration
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .toUpperCase();

    expect(statements).not.toMatch(/UPDATE\s+"?ACCOUNTS"?/);
    expect(statements).not.toMatch(/INSERT\s+INTO\s+"?SUPPLIERS"?/);
    /* The one thing it does to accounts: add the column and its constraint. */
    expect(statements).toContain('ALTER TABLE "ACCOUNTS" ADD COLUMN "SUPPLIER_ID"');
  });

  /** M10 §31: existing accounts default to "My Account" — nothing is backfilled. */
  it("adds accounts.supplier_id as nullable with no default", async () => {
    const column = await db.query<{ is_nullable: string; column_default: string | null }>(
      `select is_nullable, column_default from information_schema.columns
       where table_name = 'accounts' and column_name = 'supplier_id'`,
    );

    expect(column.rows[0]?.is_nullable).toBe("YES");
    expect(column.rows[0]?.column_default).toBeNull();
  });

  it("includes 0012, which production has NOT applied", async () => {
    /*
     * M01.5 proved production equals migrations 0000-0011 exactly (299 catalog
     * objects compared); 0012 is recorded nowhere there. This asserts the
     * migration FOLDER is right, so the pending migrate brings production level.
     */
    const checks = await db.query<{ conname: string }>(
      "select conname from pg_constraint where conrelid = 'public.customers'::regclass and contype = 'c'",
    );

    expect(checks.rows.map((row) => row.conname)).toContain("customers_phone_normalized_identity");
    expect(checks.rows.map((row) => row.conname)).not.toContain(
      "customers_phone_normalized_digits",
    );
  });
});

describe("0013 redacts historical PINs, and only PINs", () => {
  let db: PGlite;
  const redaction = readFileSync("drizzle/0013_redact_audit_pins.sql", "utf8");

  const insert = (before: unknown, after: unknown, entity = "profile") =>
    db.query(
      `insert into audit_logs (entity, entity_id, action, before, after)
       values ($1, gen_random_uuid(), 'update', $2::jsonb, $3::jsonb) returning id`,
      [entity, before === null ? null : JSON.stringify(before), JSON.stringify(after)],
    );

  const snapshotsOf = async (id: string) =>
    (
      await db.query<{ before: Record<string, unknown> | null; after: Record<string, unknown> }>(
        "select before, after from audit_logs where id = $1",
        [id],
      )
    ).rows[0]!;

  beforeAll(async () => {
    const { createIsolatedDatabase } = await import("../support/isolated-database.mjs");
    db = await createIsolatedDatabase();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("replaces a PIN in before and after, keeping everything else", async () => {
    const { rows } = await insert(
      { id: "p1", pin: "4821", profileNumber: 3, status: "sold" },
      { id: "p1", pin: "9001", profileNumber: 3, status: "sold" },
    );
    const id = (rows[0] as { id: string }).id;

    await db.exec(redaction);

    const row = await snapshotsOf(id);
    expect(row.before).toEqual({ id: "p1", pin: "[redacted]", profileNumber: 3, status: "sold" });
    expect(row.after).toEqual({ id: "p1", pin: "[redacted]", profileNumber: 3, status: "sold" });
    expect(JSON.stringify(row)).not.toMatch(/4821|9001/);
  });

  it("leaves a null PIN null — it disclosed nothing", async () => {
    const { rows } = await insert({ pin: null, status: "available" }, { pin: null });
    const id = (rows[0] as { id: string }).id;

    await db.exec(redaction);

    const row = await snapshotsOf(id);
    expect(row.before).toEqual({ pin: null, status: "available" });
    expect(row.after).toEqual({ pin: null });
  });

  it("does not touch rows that never held a PIN", async () => {
    const snapshot = { event: "password_changed", confirmedByOperator: true };
    const { rows } = await insert(null, snapshot, "account");
    const id = (rows[0] as { id: string }).id;

    await db.exec(redaction);

    const row = await snapshotsOf(id);
    expect(row.before).toBeNull();
    expect(row.after).toEqual(snapshot);
  });

  it("preserves who, what and when", async () => {
    const { rows } = await db.query<{ id: string; created_at: string }>(
      `insert into audit_logs (entity, entity_id, action, after, actor_email)
       values ('profile', gen_random_uuid(), 'update', '{"pin":"1234"}'::jsonb, 'amina@example.com')
       returning id, created_at::text`,
    );
    const { id, created_at } = rows[0]!;

    await db.exec(redaction);

    const after = await db.query<{ actor_email: string; created_at: string; action: string }>(
      "select actor_email, created_at::text, action::text from audit_logs where id = $1",
      [id],
    );
    expect(after.rows[0]).toEqual({
      actor_email: "amina@example.com",
      created_at,
      action: "update",
    });
  });

  it("is idempotent — a second run changes nothing", async () => {
    await insert({ pin: "5555" }, { pin: "6666" });
    await db.exec(redaction);

    const first = await db.query("select id, before, after from audit_logs order by id");
    await db.exec(redaction);
    const second = await db.query("select id, before, after from audit_logs order by id");

    expect(second.rows).toEqual(first.rows);
  });

  it("leaves no PIN value anywhere in the table", async () => {
    const remaining = await db.query<{ n: number }>(
      `select count(*)::int as n from audit_logs
       where (before ? 'pin' and jsonb_typeof(before->'pin') <> 'null' and before->>'pin' <> '[redacted]')
          or (after  ? 'pin' and jsonb_typeof(after->'pin')  <> 'null' and after->>'pin'  <> '[redacted]')`,
    );

    expect(remaining.rows[0]!.n).toBe(0);
  });
});
