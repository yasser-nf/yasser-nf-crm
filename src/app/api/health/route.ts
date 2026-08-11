import { sql } from "drizzle-orm";

import { APP_VERSION } from "@/config/constants";
import { databaseAdapter } from "@/lib/database";

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
