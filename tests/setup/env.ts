import { config } from "dotenv";

/**
 * Loads `.env.local` before any test module is imported.
 *
 * Calling dotenv at the top of a test file is too late: static imports are
 * hoisted above it, so a module that validates configuration at import time —
 * `src/config/env.ts` — sees an empty environment and throws. A setup file runs
 * before the module graph is built, which is the only point early enough.
 */
config({ path: ".env.local" });
