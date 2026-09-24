import { defineConfig } from "vitest/config";

import base from "./vitest.config";

/**
 * Integration tests, against an isolated database — never production.
 *
 *   npm run test:integration
 *
 * Each test file gets its own in-process PostgreSQL (PGlite) with every
 * migration applied by drizzle's own migrator and a fixed seed — see
 * tests/setup/isolated-db.per-file.ts. The production guard in
 * tests/setup/env.ts then refuses any target that is the production project,
 * whatever the environment says.
 *
 * `npm test` does NOT use this: with no TEST_DATABASE_URL the integration files
 * skip. Writing to a database is something a run has to ask for.
 *
 * Order of setupFiles matters: the database must exist, and TEST_DATABASE_URL
 * be set, before env.ts decides the target. `include` and `setupFiles` are
 * replaced rather than merged — vitest's mergeConfig concatenates arrays.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/setup/isolated-db.per-file.ts", "tests/setup/env.ts"],
  },
});
