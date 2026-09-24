/**
 * A disposable PostgreSQL for integration tests. Nothing here can reach
 * production, by construction: the database lives in this process's memory and
 * is gone when the process exits.
 *
 * WHY THIS EXISTS
 *
 * Until M01.5 the integration suite ran against whatever `.env.local` named —
 * the production database. Tests created real rows and asserted what the
 * allocation engine chose from real stock, so they passed or failed depending
 * on the day's data (M01 recorded the same files failing, then passing three
 * weeks later with no code change). That is unsafe and it is not a test.
 *
 * WHAT IT IS
 *
 * PGlite — real PostgreSQL compiled to WebAssembly, running in-process, no
 * Docker and no server install — behind a socket server, so the application's
 * own postgres.js client connects to it exactly as it connects to Supabase.
 *
 * WHAT IT IS NOT
 *
 * Supabase. What the migrations and the application read from Supabase is
 * provided by the small shim below instead: the `auth.users` table (migration
 * 0001 references it; the Users page reads invited_at / email_confirmed_at),
 * `auth.sessions` (presence and session management read it), the `auth.uid()`
 * function (0002's policies call it) and the `anon` / `authenticated` /
 * `service_role` roles (0002 revokes from them). Supabase
 * Auth and Storage are NOT emulated — a test that needs them is not isolatable
 * by this harness and must stay skipped (see tests/setup/env.ts).
 *
 * The migrations are applied with drizzle-orm's own migrator, from the real
 * `drizzle/` folder, in journal order. So every run also proves that the
 * migration history replays from nothing on a clean database.
 */

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

/**
 * The Supabase surface the migrations and the application read. Kept to the
 * columns the code actually uses; anything more would be pretending to be
 * Supabase rather than standing in for one table.
 */
export const SUPABASE_SHIM = `
  create schema if not exists auth;

  create table if not exists auth.users (
    id uuid primary key,
    email text,
    invited_at timestamptz,
    email_confirmed_at timestamptz,
    last_sign_in_at timestamptz,
    created_at timestamptz not null default now()
  );

  /* Read by sessions.repository for presence and session management. */
  create table if not exists auth.sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    not_after timestamptz,
    user_agent text,
    ip inet
  );

  create or replace function auth.uid() returns uuid
    language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  end
  $$;
`;

/**
 * The smallest fixture set the integration suite assumes exists.
 *
 * Deterministic: fixed ids, fixed emails, so a test that looks up "the super
 * admin" finds the same row every run. Production tests found whoever happened
 * to exist there. Each person gets an auth.users row first, because
 * public.users.id references it (migration 0001).
 */
export const SEED_IDS = Object.freeze({
  superAdmin: "00000000-0000-4000-8000-000000000001",
  worker: "00000000-0000-4000-8000-000000000002",
  customer: "00000000-0000-4000-8000-0000000000c1",
});

export const SEED_SQL = `
  insert into auth.users (id, email, email_confirmed_at, last_sign_in_at) values
    ('${SEED_IDS.superAdmin}', 'admin@test.invalid', now(), now()),
    ('${SEED_IDS.worker}',     'worker@test.invalid', now(), now())
  on conflict (id) do nothing;

  insert into public.users (id, name, email, role, status) values
    ('${SEED_IDS.superAdmin}', 'Test Super Admin', 'admin@test.invalid',  'super_admin', 'active'),
    ('${SEED_IDS.worker}',     'Test Worker',      'worker@test.invalid', 'worker',      'active')
  on conflict (id) do nothing;

  insert into public.customers (id, name, phone_original, phone_normalized, whatsapp_url) values
    ('${SEED_IDS.customer}', 'Seed Customer', '0550000001', '550000001', 'https://wa.me/213550000001')
  on conflict (id) do nothing;
`;

export async function seedIsolatedDatabase(db) {
  await db.exec(SEED_SQL);
}

/** A fresh database with the shim and every migration applied. */
export async function createIsolatedDatabase({ migrationsFolder = "drizzle" } = {}) {
  const db = new PGlite();

  await db.exec(SUPABASE_SHIM);
  await migrate(drizzle(db), { migrationsFolder });

  return db;
}

/**
 * The same database, reachable over the Postgres wire protocol on localhost.
 *
 * `maxConnections` > 1 because the application pool and a test's own client
 * are open at once. PGlite is single-connection underneath and the server
 * multiplexes; the suite runs files serially (vitest.config.ts), which is the
 * pattern that multiplexing supports.
 */
export async function startIsolatedDatabaseServer({
  port = 0,
  maxConnections = 16,
  seed = true,
} = {}) {
  const db = await createIsolatedDatabase();

  if (seed) {
    await seedIsolatedDatabase(db);
  }

  const server = new PGLiteSocketServer({ db, host: "127.0.0.1", port, maxConnections });

  await server.start();

  const conn = server.getServerConn();
  const url = `postgresql://postgres:postgres@${conn}/postgres?sslmode=disable`;

  return {
    url,
    db,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}
