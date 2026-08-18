/**
 * Migration rollback drill.
 *
 * Runs a migration UP -> DOWN -> UP against a disposable schema and asserts the
 * shape after each step, so a down migration is known to work rather than
 * assumed to. `drizzle/down/README.md` carried an UNVERIFIED warning for every
 * file in that directory; this is how one stops being unverified.
 *
 * It is not theoretical. The first M13 down migration FAILED this drill's
 * predecessor: it rebuilt an enum type while a CHECK constraint and a partial
 * index still bound typed literals of the old type, and PostgreSQL refused with
 * "operator does not exist: profile_status = profile_status_old". The migration
 * was redesigned to avoid the enum entirely.
 *
 * WHY A SCHEMA AND NOT A DATABASE
 *
 * There is no Docker and no psql on the development machine, and Supabase does
 * not permit CREATE DATABASE through the pooler. Migration DDL here is written
 * unqualified (ALTER TABLE "accounts"), so a search_path pointing at a
 * throwaway schema sends every statement there and never touches public. The
 * schema is dropped in a finally block whether the drill passes or fails.
 *
 * LIMITS, STATED HONESTLY
 *
 * The drill builds a MINIMAL version of each table — only the columns the
 * migration touches. It proves the migration's own SQL is reversible; it does
 * not prove it composes with every constraint on the real table. A migration
 * that touches an existing constraint or an enum needs the real shape declared
 * in TABLES below, or it will pass here and fail in production.
 *
 * Usage:
 *   node scripts/rollback-drill.mjs 0011_account_inventory
 */

import postgres from "postgres";
import { readFileSync } from "node:fs";

const tag = process.argv[2];

if (!tag) {
  console.error("Usage: node scripts/rollback-drill.mjs <migration-tag>");
  process.exit(1);
}

/**
 * Minimal table shapes the drill needs, per migration.
 *
 * Add an entry when a new migration is drilled. Include every column the
 * migration references, plus anything its constraints depend on.
 */
const TABLES = {
  "0011_account_inventory": [
    `CREATE TABLE accounts (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       email text NOT NULL,
       deleted_at timestamptz
     )`,
    `INSERT INTO accounts (email) VALUES ('a@example.invalid'), ('b@example.invalid')`,
  ],
};

const setup = TABLES[tag];

if (!setup) {
  console.error(`No table fixture for "${tag}". Add one to TABLES in this script.`);
  process.exit(1);
}

const env = readFileSync(".env.local", "utf8");
const url = /^DATABASE_URL=(.*)$/m.exec(env)?.[1]?.replace(/^["']|["']$/g, "");

if (!url || url.includes("placeholder")) {
  console.error("No usable DATABASE_URL");
  process.exit(1);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
const schema = `drill_${tag.slice(0, 4)}_${Date.now()}`;

const statementsOf = (file) =>
  readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    /* Drop comment-only chunks; they are documentation, not statements. */
    .filter((s) => s !== "" && !/^(--[^\n]*\n?)+$/.test(s));

const UP = statementsOf(`drizzle/${tag}.sql`);
const DOWN = statementsOf(`drizzle/down/${tag}.down.sql`);

let failures = 0;

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);

  if (!ok) {
    failures += 1;
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
  }
}

/** Each statement in its own transaction, with search_path scoped to the drill. */
async function run(statements, label) {
  for (const statement of statements) {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.unsafe(statement);
    });
  }
  console.log(`\n${label} — ${statements.length} statement(s) applied`);
}

async function inventoryColumns() {
  const rows = await sql`
    select column_name from information_schema.columns
    where table_schema = ${schema} and table_name = 'accounts'
      and column_name in ('profile_slots', 'valid_from', 'valid_until')
    order by column_name`;

  return rows.map((row) => row.column_name);
}

try {
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);

  for (const statement of setup) {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.unsafe(statement);
    });
  }

  console.log(`drill schema: ${schema}\nmigration:    ${tag}`);

  await run(UP, "UP (first)");
  assert("columns present", await inventoryColumns(), [
    "profile_slots",
    "valid_from",
    "valid_until",
  ]);

  const defaulted = await sql.unsafe(
    `SELECT count(*)::int AS n FROM "${schema}".accounts WHERE profile_slots = 5`,
  );
  assert("existing rows defaulted, no backfill needed", defaulted[0].n, 2);

  await run(DOWN, "DOWN");
  assert("columns gone", await inventoryColumns(), []);

  const survived = await sql.unsafe(`SELECT count(*)::int AS n FROM "${schema}".accounts`);
  assert("rows survived the rollback", survived[0].n, 2);

  await run(UP, "UP (again)");
  assert("columns back", await inventoryColumns(), ["profile_slots", "valid_from", "valid_until"]);

  /* A constraint that exists but no longer bites is worse than one that is gone. */
  let rejected = false;
  try {
    await sql.unsafe(`UPDATE "${schema}".accounts SET profile_slots = 6`);
  } catch {
    rejected = true;
  }
  assert("profile_slots range still enforced after re-apply", rejected, true);

  rejected = false;
  try {
    await sql.unsafe(
      `UPDATE "${schema}".accounts SET valid_from = '2026-12-01', valid_until = '2026-01-01'`,
    );
  } catch {
    rejected = true;
  }
  assert("validity order still enforced after re-apply", rejected, true);
} finally {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await sql.end({ timeout: 5 });
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
