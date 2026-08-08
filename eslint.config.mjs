import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Architecture rules are enforced here, not in review comments.
 *
 * A convention that tooling does not enforce is a convention that gets broken
 * during the first busy week. See ADR-003.
 */

/** Modules expose exactly one public API. Deep imports bypass that contract. */
const MODULE_BOUNDARY = {
  group: ["@/modules/*/*"],
  message:
    "Modules expose a single public API. Import from '@/modules/<feature>' instead of reaching into its internals. See ADR-003.",
};

/** Only the Database Adapter may import Drizzle. */
const DRIZZLE_BOUNDARY = {
  group: ["@/lib/drizzle", "@/lib/drizzle/*", "drizzle-orm", "drizzle-orm/*"],
  message:
    "Only the Database Adapter in '@/lib/database' may import Drizzle. Repositories describe what data is needed, the Adapter decides how it is retrieved. See ADR-003.",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...tseslint.configs.strict.map((config) => ({
    ...config,
    files: ["src/**/*.ts", "src/**/*.tsx"],
  })),

  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      // 01_MASTER_RULES.md forbids "any". A rule that is not enforced is not a rule.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": ["error", { patterns: [MODULE_BOUNDARY] }],
    },
  },

  {
    // Repositories describe WHAT. The Adapter decides HOW.
    files: ["src/modules/**/repositories/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [MODULE_BOUNDARY, DRIZZLE_BOUNDARY] }],
    },
  },

  {
    // The Adapter is the single sanctioned Drizzle import site.
    files: ["src/lib/database/**/*.ts", "src/lib/drizzle/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [MODULE_BOUNDARY] }],
    },
  },

  prettier,

  globalIgnores([".next/**", "out/**", "build/**", "drizzle/**", "next-env.d.ts"]),
]);

export default eslintConfig;
