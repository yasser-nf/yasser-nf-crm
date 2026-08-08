/**
 * Server startup hook.
 *
 * Exists to make environment validation actually fail fast.
 *
 * `config/env.server.ts` validates DATABASE_URL and throws when it is missing,
 * but a module that nothing imports never executes. Until the first repository
 * exists, nothing imports the Drizzle client, so a missing or malformed
 * DATABASE_URL would have gone unnoticed until the first database call — which
 * is exactly the late, confusing failure the validation was written to prevent.
 *
 * Next.js runs `register()` once per runtime when the server boots. Validating
 * here means a misconfigured deployment fails at startup instead of at the first
 * customer request.
 */
export async function register(): Promise<void> {
  /*
   * Only the Node runtime. The Edge runtime does not receive server-only
   * variables like DATABASE_URL, so validating there would throw on a value
   * that is legitimately absent.
   */
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  await import("@/config/env.server");
}
