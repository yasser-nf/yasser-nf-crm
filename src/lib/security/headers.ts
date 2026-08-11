/**
 * Security response headers.
 *
 * M12 Part 2 found the application shipping with none of these. That is not a
 * theoretical gap: without `X-Frame-Options` the CRM can be framed and
 * clickjacked, without HSTS a first request can be downgraded to HTTP, and
 * without a CSP an injected script runs with full page authority.
 *
 * Applied in `proxy.ts` so every response carries them — pages, Server Action
 * responses and the export Route Handler alike. Setting them in
 * `next.config.ts` would cover static routes but is easy to bypass for
 * dynamically generated responses, and this application is entirely dynamic.
 *
 * Pure, and unit tested: a header policy nobody checks is a header policy that
 * silently loosens.
 */

/**
 * Content Security Policy.
 *
 * `'unsafe-inline'` for styles is unavoidable here: Tailwind and Next inject
 * inline style attributes, and no nonce reaches them. It is a real weakening
 * and is recorded rather than hidden.
 *
 * `'unsafe-eval'` is permitted only in development, where React Refresh needs
 * it. Production gets neither.
 *
 * `connect-src` must include the Supabase project — the browser client talks to
 * it directly for auth. It is read from the environment rather than wildcarded,
 * so a compromised page cannot exfiltrate to an arbitrary host.
 */
export function contentSecurityPolicy(supabaseUrl: string, isDevelopment: boolean): string {
  const scriptSrc = isDevelopment
    ? "'self' 'unsafe-inline' 'unsafe-eval'"
    : "'self' 'unsafe-inline'";

  /* Supabase realtime uses wss://; derive it rather than hardcoding a second URL. */
  const supabaseSocket = supabaseUrl.replace(/^https:/, "wss:");

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${supabaseUrl} ${supabaseSocket}`,
    /* No plugins, no Flash, no applets. */
    "object-src 'none'",
    /* Nothing may set a <base> and rewrite every relative URL on the page. */
    "base-uri 'self'",
    /* Forms may only post back to this origin. */
    "form-action 'self'",
    /* The modern equivalent of X-Frame-Options: DENY. */
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export interface HeaderOptions {
  readonly supabaseUrl: string;
  readonly isDevelopment: boolean;
}

/**
 * Every security header this application sets.
 *
 * HSTS is omitted in development: sending it from localhost pins the browser to
 * HTTPS for that host, which then breaks every other local project on the same
 * port. It is a genuinely painful thing to undo, so it is production-only.
 */
export function securityHeaders({
  supabaseUrl,
  isDevelopment,
}: HeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy(supabaseUrl, isDevelopment),

    /* Legacy but still honoured; frame-ancestors above is the modern control. */
    "X-Frame-Options": "DENY",

    /* Stops a browser guessing a content type and executing a download. */
    "X-Content-Type-Options": "nosniff",

    /*
     * A CRM URL can contain a customer or account id. Sending a full referrer
     * to an external site would leak it.
     */
    "Referrer-Policy": "strict-origin-when-cross-origin",

    /* Nothing in this application needs any of these. */
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",

    /* Legacy header; harmless and still read by some corporate proxies. */
    "X-DNS-Prefetch-Control": "off",
  };

  if (!isDevelopment) {
    /* Two years, subdomains included, preload-eligible. */
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
  }

  return headers;
}
