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

/**
 * A shape-valid but publicly known key, so the project builds before a real one
 * exists. It is detectable, so nothing can mistake it for real protection.
 */
export const PLACEHOLDER_ENCRYPTION_KEY =
  "0000000000000000000000000000000000000000000000000000000000000000";

/** AES-256 requires exactly 32 bytes, expressed as 64 hex characters. */
const ENCRYPTION_KEY_HEX_LENGTH = 64;

const serverEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .startsWith("postgres", "DATABASE_URL must be a PostgreSQL connection string"),
  ENCRYPTION_KEY: z
    .string()
    .min(1, "ENCRYPTION_KEY is required")
    .length(
      ENCRYPTION_KEY_HEX_LENGTH,
      `ENCRYPTION_KEY must be ${ENCRYPTION_KEY_HEX_LENGTH} hex characters (32 bytes for AES-256)`,
    )
    .regex(/^[0-9a-fA-F]+$/, "ENCRYPTION_KEY must be hexadecimal"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = serverEnvSchema.safeParse({
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
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

/**
 * Whether a real encryption key is configured.
 *
 * The placeholder is a published constant, so anything encrypted with it is
 * readable by anyone holding this source. Encrypting real credentials under it
 * would be worse than not encrypting them, because it would look protected.
 */
export function isEncryptionConfigured(): boolean {
  return serverEnv.ENCRYPTION_KEY !== PLACEHOLDER_ENCRYPTION_KEY;
}
