import { sql } from "drizzle-orm";

import { APP_VERSION } from "@/config/constants";
import { env, isSupabaseConfigured } from "@/config/env";
import { databaseAdapter } from "@/lib/database";

/**
 * The Supabase project reference from its URL.
 *
 * `https://abcdefgh.supabase.co` → `abcdefgh`. This is the value
 * `@supabase/ssr` uses to name its auth cookie, which is why it is the one
 * piece of configuration worth exposing here. It is not a secret: it is already
 * visible in the browser bundle and in every request the client makes.
 */
function projectRefFrom(url: string): string {
  try {
    return new URL(url).hostname.split(".")[0] ?? "unknown";
  } catch {
    return "unparseable";
  }
}

/**
 * Health endpoint.
 *
 * M12 Part 5. Deliberately **unauthenticated** — a health check a load
 * balancer cannot reach is not a health check — which is why it discloses
 * nothing an attacker could use: no versions of dependencies, no connection
 * strings, no counts, no environment detail beyond liveness.
 *
 * The second Route Handler in the application, and the reason is the same one
 * that justified the first (ADR-011 D3): a Server Action cannot be reached by
 * an uptime monitor. Recorded in ADR-013.
 *
 * Two levels, because they answer different questions:
 *
 *   liveness   is the process up? Cheap, no dependencies.
 *   readiness  can it serve traffic? Touches the database.
 *
 * A deploy platform restarts on failed liveness and withholds traffic on failed
 * readiness. Conflating them makes a database blip restart a healthy process.
 */

export const dynamic = "force-dynamic";

/** Database probe budget. Beyond this the dependency is unhealthy, not slow. */
const PROBE_TIMEOUT_MS = 2_000;

async function probeDatabase(): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();

  /*
   * Raced against a timeout. Without one, a hung connection makes the health
   * check itself hang, and an uptime monitor reports a timeout rather than the
   * unhealthy status this endpoint exists to report.
   */
  const probe = databaseAdapter.query("health.probe", async (executor) => {
    await executor.execute(sql`select 1`);
    return true;
  });

  const timeout = new Promise<false>((resolve) => {
    setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });

  const outcome = await Promise.race([probe, timeout]);
  const latencyMs = Date.now() - started;

  if (outcome === false) {
    return { ok: false, latencyMs };
  }

  return { ok: outcome.ok, latencyMs };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  /* `?probe=liveness` skips the database entirely. */
  if (url.searchParams.get("probe") === "liveness") {
    return Response.json(
      { status: "ok", version: APP_VERSION, uptimeSeconds: Math.round(process.uptime()) },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  const database = await probeDatabase();

  const body = {
    status: database.ok ? "ok" : "degraded",
    version: APP_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    checks: {
      database: {
        status: database.ok ? "ok" : "failing",
        latencyMs: database.latencyMs,
      },
      /*
       * The Supabase project this *runtime* is configured for, as a project ref
       * only — never the URL, never a key.
       *
       * `NEXT_PUBLIC_*` is inlined into the browser bundle at build time while
       * the proxy reads it at runtime. If the two disagree, the browser writes
       * `sb-<A>-auth-token` and the proxy looks for `sb-<B>-auth-token`, finds
       * nothing, and redirects an authenticated user back to /login. Comparing
       * this value against the cookie name in the browser identifies that in
       * one request instead of by inspection.
       */
      auth: {
        projectRef: projectRefFrom(env.NEXT_PUBLIC_SUPABASE_URL),
        expectedCookiePrefix: `sb-${projectRefFrom(env.NEXT_PUBLIC_SUPABASE_URL)}-auth-token`,
        configured: isSupabaseConfigured(),
      },
    },
  };

  /*
   * 503 when a dependency is down, so a monitor reacts to the status code
   * rather than having to parse the body.
   */
  return Response.json(body, {
    status: database.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
