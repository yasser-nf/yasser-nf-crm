import "server-only";

import { z } from "zod";

/**
 * Server-only environment configuration.
 *
 * 01_MASTER_RULES.md: never expose secrets, never expose service keys.
 *
 * The `server-only` import above is the enforcement. If any client component
 * ever imports this module, the build fails rather than shipping a secret to
 * the browser. That guarantee is structural, not a matter of remembering.
 */

export const PLACEHOLDER_DATABASE_URL =
  "postgresql://postgres:placeholder@placeholder.supabase.co:5432/postgres";

const serverEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .startsWith("postgres", "DATABASE_URL must be a PostgreSQL connection string"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = serverEnvSchema.safeParse({
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
});

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `  - ${issue.message}`).join("\n");

  throw new Error(
    `Invalid server environment configuration:\n${details}\n\n` +
      `Copy .env.example to .env.local and fill in the values.`,
  );
}

export const serverEnv = parsed.data;

export const isProduction = serverEnv.NODE_ENV === "production";
export const isDevelopment = serverEnv.NODE_ENV === "development";

/** Whether a real database is configured, as opposed to the placeholder. */
export function isDatabaseConfigured(): boolean {
  return serverEnv.DATABASE_URL !== PLACEHOLDER_DATABASE_URL;
}
