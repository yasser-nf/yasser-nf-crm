import "server-only";

/**
 * Where this deployment actually lives.
 *
 * Needed because an invitation link is built by the server and opened days
 * later on somebody else's machine. Without an absolute origin the CRM cannot
 * name itself, and Supabase falls back to the project's dashboard Site URL —
 * which was `http://localhost:3000`, so every invited person was sent to a
 * server on their own laptop. That was the 404.
 *
 * Resolution order, most explicit first:
 *
 *   1. APP_URL              — set it, and it wins. The only one that survives a
 *                             custom domain, which is what real invitations use.
 *   2. VERCEL_PROJECT_PRODUCTION_URL
 *                           — Vercel's stable production hostname. Constant
 *                             across deployments, unlike VERCEL_URL.
 *   3. VERCEL_URL           — the per-deployment hostname. A last resort: it
 *                             changes on every deploy, so a link built from it
 *                             outlives its own host.
 *   4. http://localhost:3000 — development only.
 *
 * Deliberately NOT a NEXT_PUBLIC variable. Nothing in a browser needs it, and a
 * public one could be read back from the bundle and trusted; this value decides
 * where an authentication email points, so it stays server-side.
 */

export const LOCAL_APP_URL = "http://localhost:3000";

/** Strips a trailing slash so callers can join paths without doubling it. */
function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Adds a scheme to a bare hostname.
 *
 * Vercel exposes its host without one — `yasser-nf-crm.vercel.app`, not a URL —
 * and `new URL()` rejects that, so a link built from it would silently become a
 * relative path.
 */
function withScheme(value: string): string {
  return /^https?:\/\//.test(value) ? value : `https://${value}`;
}

/**
 * The origin to build absolute links from.
 *
 * Reads `process.env` on each call rather than caching at module load: this is
 * used inside request handling, and a cached value would freeze whatever was
 * set when the lambda was first initialised.
 */
export function resolveAppUrl(): string {
  const explicit = process.env["APP_URL"]?.trim();

  if (explicit) {
    return normalizeOrigin(withScheme(explicit));
  }

  const vercelProduction = process.env["VERCEL_PROJECT_PRODUCTION_URL"]?.trim();

  if (vercelProduction) {
    return normalizeOrigin(withScheme(vercelProduction));
  }

  const vercelDeployment = process.env["VERCEL_URL"]?.trim();

  if (vercelDeployment) {
    return normalizeOrigin(withScheme(vercelDeployment));
  }

  return LOCAL_APP_URL;
}

/** An absolute URL for a path in this app. `path` must start with `/`. */
export function absoluteUrl(path: string): string {
  return `${resolveAppUrl()}${path}`;
}
