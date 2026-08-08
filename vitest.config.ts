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
       */
      "server-only": new URL("./tests/stubs/server-only.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
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
