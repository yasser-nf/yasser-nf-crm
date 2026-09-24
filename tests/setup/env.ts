import { config } from "dotenv";

import { PLACEHOLDER_DATABASE_URL, resolveIntegrationTarget } from "../support/database-target.mjs";

/**
 * Loads configuration before any test module is imported, and decides — once,
 * here — which database the integration suite may touch.
 *
 * Calling dotenv at the top of a test file is too late: static imports are
 * hoisted above it, so a module that validates configuration at import time —
 * `src/config/env.ts` — sees an empty environment and throws. A setup file runs
 * before the module graph is built, which is the only point early enough.
 *
 * WHAT CHANGED IN M01.5
 *
 * This file used to load `.env.local` and stop. `.env.local`'s DATABASE_URL is
 * production, so the integration suite created and deleted real rows there, and
 * its results depended on production stock. Now:
 *
 *   - `.env.local` is still loaded, for the non-database settings unit tests
 *     read. But its DATABASE_URL is never handed to a test.
 *   - With no TEST_DATABASE_URL, DATABASE_URL becomes the placeholder that
 *     every integration file already recognises, so the whole integration
 *     suite SKIPS. `npm test` is safe by default.
 *   - With TEST_DATABASE_URL, the target must pass resolveIntegrationTarget,
 *     which refuses production outright — the run fails loudly rather than
 *     writing a single row there.
 *
 * In isolated mode the Supabase credentials are neutralised as well. An
 * isolated database is not isolation if a test can still call the production
 * project's Auth or Storage API, so those tests fail closed or skip instead.
 */

config({ path: ".env.local", quiet: true });

/*
 * The application database, as .env.local names it. Captured before anything
 * below overwrites DATABASE_URL, because it is what "production" means to the
 * guard.
 */
const productionDatabaseUrl = process.env["DATABASE_URL"];

const target = resolveIntegrationTarget({
  testDatabaseUrl: process.env["TEST_DATABASE_URL"],
  productionDatabaseUrl,
  allowRemoteHost: process.env["ALLOW_REMOTE_TEST_DATABASE"],
});

if (target.mode === "skip") {
  process.env["DATABASE_URL"] = PLACEHOLDER_DATABASE_URL;
} else {
  process.env["DATABASE_URL"] = target.databaseUrl;

  /* Fail closed: nothing below can reach the production Supabase project. */
  process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://placeholder.supabase.co";
  process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = "placeholder-anon-key";
  delete process.env["SUPABASE_SERVICE_ROLE_KEY"];

  /*
   * A test key, so fixtures are encrypted with something that is not the
   * production credential key. 64 hex characters, deliberately not all zeros
   * (the application refuses an all-zero key as insecure).
   */
  process.env["ENCRYPTION_KEY"] = "a1".repeat(32);

  /*
   * One application connection. The in-process database is single-session
   * behind a multiplexer, and concurrent pool connections interleave there.
   * Harmless for a remote test database too — only slower.
   */
  process.env["DB_POOL_MAX"] = "1";
}
