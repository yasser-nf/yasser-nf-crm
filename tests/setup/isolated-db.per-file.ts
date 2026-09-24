/**
 * A fresh, seeded, isolated database for EACH integration test file.
 *
 * Runs before tests/setup/env.ts (see vitest.integration.config.ts), so the
 * TEST_DATABASE_URL it sets is what the production guard then examines.
 *
 * Per file rather than per run, for two reasons found the hard way in M01.5:
 *
 *   - Isolation between files. Integration files create accounts, customers
 *     and allocations; sharing one database let one file's leftovers become the
 *     next file's stock — the same data-dependence that made the suite
 *     untrustworthy against production, merely moved.
 *   - Reliability. With all 24 files on one in-process database the run
 *     stalled for over 30 minutes, while every file passed alone. A database
 *     that lives exactly as long as its file cannot accumulate connections or
 *     state across files.
 *
 * Cost: about two seconds per file to replay every migration. Cheap for a
 * suite that used to depend on the day's production data.
 *
 * To run against a deliberately provisioned non-production database instead,
 * set EXTERNAL_TEST_DATABASE_URL (and ALLOW_REMOTE_TEST_DATABASE for its host);
 * no local database is started, and the guard still refuses production.
 */

import { afterAll } from "vitest";

import { startIsolatedDatabaseServer } from "../support/isolated-database.mjs";

const external = process.env["EXTERNAL_TEST_DATABASE_URL"];

if (external) {
  process.env["TEST_DATABASE_URL"] = external;
} else {
  const server = await startIsolatedDatabaseServer();
  process.env["TEST_DATABASE_URL"] = server.url;

  afterAll(async () => {
    await server.stop();
  });
}
