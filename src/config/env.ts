import { z } from "zod";

/**
 * Public environment configuration.
 *
 * ADR-001: only NEXT_PUBLIC variables may reach the browser. This module is
 * therefore safe to import from client components. Server-only secrets live in
 * `env.server.ts`, which is guarded by the `server-only` package.
 *
 * Validation runs at module load and throws. A misconfigured application should
 * refuse to start rather than fail later in a way that looks like a bug.
 */

/**
 * Placeholder values used before a real Supabase project exists.
 *
 * These are shape-valid so the project still builds and typechecks, but they
 * point at nothing. Authentication is never mocked — it fails honestly against
 * an address that does not resolve. Detecting them lets the UI explain the
 * situation instead of surfacing a raw network error.
 */
export const PLACEHOLDER_SUPABASE_URL = "https://placeholder.supabase.co";
export const PLACEHOLDER_SUPABASE_ANON_KEY = "placeholder-anon-key";

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z
    .string()
    .min(1, "NEXT_PUBLIC_SUPABASE_URL is required")
    .url("NEXT_PUBLIC_SUPABASE_URL must be a valid URL"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, "NEXT_PUBLIC_SUPABASE_ANON_KEY is required"),
});

/**
 * Next.js inlines NEXT_PUBLIC_* at build time by matching the literal text
 * `process.env.NEXT_PUBLIC_...`. Destructuring or dynamic access silently
 * yields undefined in the browser, so each variable is referenced literally.
 */
const parsed = publicEnvSchema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `  - ${issue.message}`).join("\n");

  throw new Error(
    `Invalid public environment configuration:\n${details}\n\n` +
      `Copy .env.example to .env.local and fill in the values.`,
  );
}

export const env = parsed.data;

/**
 * Whether a real Supabase project is configured.
 *
 * Used to render an explicit "not configured" state instead of letting the user
 * watch a login attempt fail against an address that does not exist.
 */
export function isSupabaseConfigured(): boolean {
  return (
    env.NEXT_PUBLIC_SUPABASE_URL !== PLACEHOLDER_SUPABASE_URL &&
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== PLACEHOLDER_SUPABASE_ANON_KEY
  );
}
