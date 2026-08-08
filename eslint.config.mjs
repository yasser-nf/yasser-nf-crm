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

/**
 * Only the Database Adapter may hold a database connection.
 *
 * ADR-005 Decision 5 corrected this rule. It previously blocked `drizzle-orm`
 * entirely, which made repositories unimplementable: a repository must build
 * queries for its table, and ADR-003 simultaneously forbids the Adapter from
 * building table-specific queries, so no code could build a query at all.
 *
 * The boundary that carries the intent is the connection, not the query builder.
 * Repositories may use Drizzle's operators and the schema; they may not obtain a
 * connection, so they cannot bypass error translation, the retry policy, or
 * transaction scoping.
 */
const DATABASE_CONNECTION_BOUNDARY = {
  group: ["@/lib/drizzle/client", "postgres"],
  message:
    "Only the Database Adapter in '@/lib/database' may hold a database connection. Execute queries through databaseAdapter.query or .transaction so error translation and the retry policy are not bypassed. See ADR-005 Decision 5.",
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
    // Repositories describe WHAT. The Adapter decides HOW, and owns the connection.
    files: ["src/modules/**/repositories/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [MODULE_BOUNDARY, DATABASE_CONNECTION_BOUNDARY] },
      ],
    },
  },

  {
    // The Adapter and the Drizzle module are the sanctioned connection holders.
    files: ["src/lib/database/**/*.ts", "src/lib/drizzle/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [MODULE_BOUNDARY] }],
    },
  },

  prettier,

  globalIgnores([".next/**", "out/**", "build/**", "drizzle/**", "next-env.d.ts"]),
]);

export default eslintConfig;
