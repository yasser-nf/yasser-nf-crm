import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, securityHeaders } from "@/lib/security/headers";

/**
 * Security header tests.
 *
 * M12 Part 2 found the application shipping with no security headers at all.
 * These pin the policy so it cannot silently loosen — the failure mode for
 * headers is that somebody adds a wildcard to fix a console warning and nobody
 * notices for a year.
 */

const SUPABASE = "https://project.supabase.co";

function production() {
  return securityHeaders({ supabaseUrl: SUPABASE, isDevelopment: false });
}

describe("securityHeaders", () => {
  it("sets every header the application relies on", () => {
    const headers = production();

    for (const name of [
      "Content-Security-Policy",
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Strict-Transport-Security",
    ]) {
      expect(headers[name], name).toBeTruthy();
    }
  });

  it("denies framing, which is the clickjacking control", () => {
    expect(production()["X-Frame-Options"]).toBe("DENY");
    expect(production()["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

  it("stops content-type sniffing", () => {
    expect(production()["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("does not leak a CRM URL to another origin", () => {
    /* A URL here can contain a customer or account id. */
    expect(production()["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("sets a long HSTS in production", () => {
    const hsts = production()["Strict-Transport-Security"] ?? "";

    expect(hsts).toContain("includeSubDomains");
    expect(hsts).toContain("preload");

    const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0);
    expect(maxAge).toBeGreaterThanOrEqual(31_536_000);
  });

  it("omits HSTS in development", () => {
    /*
     * Sending HSTS from localhost pins the browser to HTTPS for that host and
     * breaks every other local project on the same port — painful to undo.
     */
    const headers = securityHeaders({ supabaseUrl: SUPABASE, isDevelopment: true });
    expect(headers["Strict-Transport-Security"]).toBeUndefined();
  });
});

describe("contentSecurityPolicy", () => {
  it("defaults to self and forbids plugins", () => {
    const policy = contentSecurityPolicy(SUPABASE, false);

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
  });

  it("never allows eval in production", () => {
    expect(contentSecurityPolicy(SUPABASE, false)).not.toContain("unsafe-eval");
  });

  it("allows eval only in development, for React Refresh", () => {
    expect(contentSecurityPolicy(SUPABASE, true)).toContain("unsafe-eval");
  });

  it("names the Supabase origin rather than wildcarding connect-src", () => {
    /*
     * The point of the whole policy: a compromised page must not be able to
     * exfiltrate to an arbitrary host.
     */
    const policy = contentSecurityPolicy(SUPABASE, false);

    expect(policy).toContain(`connect-src 'self' ${SUPABASE}`);
    expect(policy).toContain("wss://project.supabase.co");
    expect(policy).not.toMatch(/connect-src[^;]*\*/);
  });

  it("never wildcards a script or default source", () => {
    const policy = contentSecurityPolicy(SUPABASE, false);

    expect(policy).not.toMatch(/script-src[^;]*\*/);
    expect(policy).not.toMatch(/default-src[^;]*\*/);
  });

  it("upgrades insecure requests", () => {
    expect(contentSecurityPolicy(SUPABASE, false)).toContain("upgrade-insecure-requests");
  });
});
