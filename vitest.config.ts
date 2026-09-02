import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Vitest configuration.
 *
 * Unit tests only — pure logic with no database and no network. They must stay
 * fast enough that nobody is tempted to skip them, so anything requiring a
 * connection belongs in an integration suite rather than here.
 *
 * `vite-tsconfig-paths` resolves the `@/` alias, so tests import modules exactly
 * as the application does rather than through relative paths that would drift.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      /*
       * `server-only` throws on import outside a React Server Component. Module
       * barrels re-export server modules alongside pure ones, so importing the
       * public API of a module would fail here.
       *
       * Stubbing it lets tests import exactly what the application imports,
       * rather than reaching past the barrel into internal paths — which would
       * mean the tests stop exercising the module's real contract.
       *
       * fileURLToPath, not URL.pathname: this project lives under a directory
       * with a space in its name, and pathname percent-encodes it into a path
       * that does not exist. The alias then silently failed to resolve, which
       * went unnoticed until a test first imported a module barrel.
       */
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    /*
     * Integration tests run against the real database and skip themselves when
     * only placeholder credentials are present, so a fresh clone and CI both
     * stay green without a project.
     */
    /*
     * `.tsx` is included so a component can be rendered where its behaviour
     * cannot be expressed as a pure function — a confirmation dialog that must
     * not submit twice, for instance. Such a file opts into jsdom with its own
     * `@vitest-environment` docblock; the environment below stays `node`, so
     * the rest of the suite keeps its speed.
     */
    include: [
      "tests/unit/**/*.test.ts",
      "tests/unit/**/*.test.tsx",
      "tests/integration/**/*.test.ts",
    ],
    setupFiles: ["tests/setup/env.ts"],
    /*
     * One file at a time.
     *
     * Every integration file opens its own postgres client, and the application's
     * Drizzle pool holds up to ten more. Supabase's session pooler caps the
     * project at 15 clients, so running files in parallel exhausts it and the
     * suite fails with EMAXCONNSESSION — a connection limit, not a defect in the
     * code under test. Serial execution is slower and honest; a flaky suite that
     * blames the wrong thing is worse.
     */
    fileParallelism: false,
    /*
     * Stop the dev server before running the integration suite.
     *
     * Supabase's session pooler caps this project at 15 clients and the Next
     * dev server holds a pool of up to 10. With it running, the suite starves
     * for connections: the same tests that finish in 12 seconds took nearly
     * eight hours and reported five failures that had nothing to do with the
     * code. Recorded here because the symptom points at the wrong thing.
     */
    testTimeout: 30_000,
    /*
     * Hooks get the same budget as tests. The default is 10s, and an integration
     * `beforeAll` that opens a connection and reads a few rows over a remote
     * pooler can exceed that on a cold start — a timeout there reports as a
     * failed suite rather than a slow one.
     */
    hookTimeout: 30_000,
    environment: "node",
    globals: false,
    reporters: ["default"],
    coverage: {
      include: [
        "src/lib/phone/**",
        "src/lib/clipboard/**",
        "src/utils/**",
        "src/modules/**/services/allocation-engine.ts",
      ],
    },
  },
});
