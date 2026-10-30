import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * M09B: what migration 0016 does to the accounts that already exist.
 *
 * The replay test elsewhere runs the whole history against an empty database,
 * which proves the SQL is valid but says nothing about the rows production
 * already holds. This one stages exactly that situation — migrations 0000–0015
 * applied, accounts inserted, THEN 0016 — because the one-line difference
 * between classifying those accounts `owned` and leaving them to a default of
 * `unknown` is invisible in a replay and wrong in production.
 *
 * The operator confirmed every account that exists today is the business's
 * own. That is the fact this asserts.
 */

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
  entries: { idx: number; tag: string }[];
};

/** A migration's SQL, as the migrator would run it. */
function sqlFor(tag: string): string {
  return readFileSync(`drizzle/${tag}.sql`, "utf8").split("--> statement-breakpoint").join("\n");
}

const BEFORE_SUPPLIERS = journal.entries.filter((entry) => entry.idx <= 15);
const SUPPLIERS_MIGRATION = journal.entries.find((entry) => entry.tag === "0016_suppliers");

describe("migration 0016, against accounts that already exist", () => {
  let db: PGlite;

  beforeAll(async () => {
    const { PGlite: Client } = await import("@electric-sql/pglite");
    const { SUPABASE_SHIM } = await import("../support/isolated-database.mjs");

    db = new Client();
    await db.exec(SUPABASE_SHIM);

    /* Everything up to, but not including, the supplier migration. */
    for (const entry of BEFORE_SUPPLIERS) {
      await db.exec(sqlFor(entry.tag));
    }
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  it("starts from a schema that has no ownership column at all", async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'accounts'
         and column_name in ('ownership', 'supplier_id')`,
    );

    expect(rows).toHaveLength(0);
    expect(SUPPLIERS_MIGRATION, "0016_suppliers must exist in the journal").toBeDefined();
  });

  it("classifies every pre-existing account as owned, and changes nothing else", async () => {
    /* Three accounts of the kind production holds, including an archived one. */
    await db.exec(`
      insert into accounts (email, password_encrypted, status, country, notes, archived_at)
      values ('one@example.invalid',   'v1:a:b:c', 'healthy',         'DZ', 'kept', null),
             ('two@example.invalid',   'v1:d:e:f', 'payment_problem', 'MA', null,   null),
             ('three@example.invalid', 'v1:g:h:i', 'healthy',         null, null,   now());
    `);

    const before = await db.query<{ email: string; password_encrypted: string; status: string }>(
      "select email, password_encrypted, status from accounts order by email",
    );

    await db.exec(sqlFor(SUPPLIERS_MIGRATION!.tag));

    const after = await db.query<{
      email: string;
      ownership: string;
      supplier_id: string | null;
      password_encrypted: string;
      status: string;
    }>(
      `select email, ownership::text as ownership, supplier_id, password_encrypted, status
       from accounts order by email`,
    );

    expect(after.rows).toHaveLength(3);

    for (const row of after.rows) {
      /* The whole point: owned, not unknown and not supplied. */
      expect(row.ownership, row.email).toBe("owned");
      expect(row.supplier_id, row.email).toBeNull();
    }

    /* The archived one is classified too — it is still the business's account. */
    expect(after.rows.map((row) => row.email)).toEqual([
      "one@example.invalid",
      "three@example.invalid",
      "two@example.invalid",
    ]);

    /* Nothing else about the rows moved. */
    expect(
      after.rows.map((row) => ({ e: row.email, p: row.password_encrypted, s: row.status })),
    ).toEqual(
      before.rows.map((row) => ({ e: row.email, p: row.password_encrypted, s: row.status })),
    );
  });

  it("defaults an account written AFTER the migration to unknown", async () => {
    /*
     * The migration classifies history explicitly and then leaves the default
     * at `unknown`, so code that forgets to say where an account came from
     * cannot silently claim the business owns it.
     */
    await db.exec(
      `insert into accounts (email, password_encrypted) values ('later@example.invalid', 'v1:j:k:l')`,
    );

    const { rows } = await db.query<{ ownership: string }>(
      "select ownership::text as ownership from accounts where email = 'later@example.invalid'",
    );

    expect(rows[0]?.ownership).toBe("unknown");
  });

  it("refuses a supplier on an account that is not supplied", async () => {
    await db.exec(
      `insert into suppliers (id, name) values ('11111111-1111-4111-8111-111111111111', 'Test Supplier')`,
    );

    await expect(
      db.exec(
        `update accounts set supplier_id = '11111111-1111-4111-8111-111111111111'
         where email = 'one@example.invalid'`,
      ),
    ).rejects.toThrow(/accounts_supplier_requires_supplied/);

    /* The same account may hold it once it is marked supplied. */
    await db.exec(
      `update accounts set ownership = 'supplied', supplier_id = '11111111-1111-4111-8111-111111111111'
       where email = 'one@example.invalid'`,
    );

    const { rows } = await db.query<{ ownership: string; supplier_id: string }>(
      "select ownership::text as ownership, supplier_id from accounts where email = 'one@example.invalid'",
    );
    expect(rows[0]).toMatchObject({ ownership: "supplied" });
  });

  it("refuses to delete a supplier that accounts still name", async () => {
    await expect(
      db.exec(`delete from suppliers where id = '11111111-1111-4111-8111-111111111111'`),
    ).rejects.toThrow(/update or delete on table "suppliers"/);
  });

  it("treats supplier names case-insensitively, ignoring surrounding space", async () => {
    /*
     * The index compares lower(btrim(name)), so case and surrounding spaces
     * collapse here. Runs of space INSIDE a name are collapsed a layer up, by
     * the service's schema, because btrim cannot do it — noted so the two
     * halves of the rule are not mistaken for one.
     */
    await expect(
      db.exec(`insert into suppliers (name) values ('  TEST SUPPLIER ')`),
    ).rejects.toThrow(/suppliers_name_unique_live/);

    /* A different name is fine, and so is the old name once the row is deleted. */
    await db.exec(`insert into suppliers (name) values ('Another Supplier')`);
    await db.exec(
      `update suppliers set deleted_at = now() where id = '11111111-1111-4111-8111-111111111111'`,
    );
    await db.exec(`insert into suppliers (name) values ('Test Supplier')`);

    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from suppliers where deleted_at is null",
    );
    expect(rows[0]?.n).toBe(2);
  });
});
