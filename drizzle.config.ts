import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// ADR-001: only .env.local is used. dotenv defaults to .env, so it is named here.
loadEnv({ path: ".env.local" });

/**
 * Drizzle Kit configuration.
 *
 * drizzle-kit is a CLI and does not go through Next.js, so it never sees
 * .env.local automatically. dotenv loads it explicitly above.
 *
 * Migrations should use the DIRECT connection string (port 5432), not the
 * pooled one (6543) — the transaction pooler cannot run DDL reliably.
 */

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/drizzle/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
