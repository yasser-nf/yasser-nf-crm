import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_FLOW_ROUTES,
  DEFAULT_AUTHENTICATED_ROUTE,
  PUBLIC_ROUTES,
  ROUTES,
  UNAUTHENTICATED_ENDPOINTS,
} from "@/config/constants";
import { buildSetPasswordSchema } from "@/modules/auth/validation/set-password.schema";

/**
 * The invitation flow.
 *
 * The bug: every invited person landed on a browser error page. Three faults,
 * each sufficient on its own.
 *
 *   1. `inviteUserByEmail(email)` was called with no `redirectTo`, so Supabase
 *      fell back to the project's dashboard Site URL — `http://localhost:3000`.
 *      The recipient's browser was sent to a server on their own machine.
 *      Confirmed live: /auth/v1/verify 303s to `http://localhost:3000/#error=…`.
 *   2. No route existed to receive the redirect. The App Router had exactly one
 *      non-application route, /login.
 *   3. Even with both fixed, the proxy would have bounced an unauthenticated
 *      visitor off the callback to /login, discarding the invitation.
 *
 * These lock all three down, and the security properties that must survive them.
 */

/**
 * Only the three keys this file touches are saved and put back.
 *
 * Reassigning `process.env` wholesale would replace the object other modules
 * already hold a reference to — which is how a test about invitation URLs can
 * break an integration test about database connections two files later.
 */
const URL_KEYS = ["APP_URL", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL"] as const;
const ORIGINAL: Partial<Record<(typeof URL_KEYS)[number], string | undefined>> = {};

async function loadAppUrl() {
  /* Re-imported per test: the resolver reads process.env on each call, and the
     module must not cache a value from whichever test ran first. */
  vi.resetModules();
  return import("@/config/app-url");
}

beforeEach(() => {
  for (const key of URL_KEYS) {
    ORIGINAL[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of URL_KEYS) {
    const value = ORIGINAL[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("the invitation URL points at production", () => {
  it("uses APP_URL when it is set", async () => {
    process.env["APP_URL"] = "https://crm.example.com";
    const { resolveAppUrl } = await loadAppUrl();

    expect(resolveAppUrl()).toBe("https://crm.example.com");
  });

  it("prefers APP_URL over Vercel's hostnames", async () => {
    /*
     * A custom domain is what real invitations use. The Vercel hostname would
     * still work, but a link that says vercel.app in somebody's inbox is not
     * the one this CRM should be sending.
     */
    process.env["APP_URL"] = "https://crm.example.com";
    process.env["VERCEL_PROJECT_PRODUCTION_URL"] = "yasser-nf-crm.vercel.app";
    const { resolveAppUrl } = await loadAppUrl();

    expect(resolveAppUrl()).toBe("https://crm.example.com");
  });

  it("falls back to Vercel's STABLE production hostname before the per-deploy one", async () => {
    /*
     * VERCEL_URL changes with every deployment, so an invitation built from it
     * outlives its own host. The production hostname does not move.
     */
    process.env["VERCEL_PROJECT_PRODUCTION_URL"] = "yasser-nf-crm.vercel.app";
    process.env["VERCEL_URL"] = "yasser-nf-abc123-yasser-nf-crm.vercel.app";
    const { resolveAppUrl } = await loadAppUrl();

    expect(resolveAppUrl()).toBe("https://yasser-nf-crm.vercel.app");
  });

  it("adds https to a bare Vercel hostname", async () => {
    /* Vercel exposes a host, not a URL. Without a scheme the link becomes a
       relative path and the invitation breaks in a different way. */
    process.env["VERCEL_URL"] = "yasser-nf-crm.vercel.app";
    const { resolveAppUrl } = await loadAppUrl();

    expect(resolveAppUrl()).toBe("https://yasser-nf-crm.vercel.app");
  });

  it("never leaves a trailing slash to double up on the path", async () => {
    process.env["APP_URL"] = "https://crm.example.com/";
    const { absoluteUrl } = await loadAppUrl();

    expect(absoluteUrl("/auth/callback")).toBe("https://crm.example.com/auth/callback");
  });

  it("only falls back to localhost when nothing else is configured", async () => {
    const { resolveAppUrl, LOCAL_APP_URL } = await loadAppUrl();

    expect(resolveAppUrl()).toBe(LOCAL_APP_URL);
    expect(LOCAL_APP_URL).toBe("http://localhost:3000");
  });

  it("builds a callback URL that is absolute and on the app's own origin", async () => {
    /*
     * The single assertion the whole bug reduces to. This value is what the
     * invitation email links to; when it was absent, Supabase substituted
     * localhost and the recipient got a dead page.
     */
    process.env["APP_URL"] = "https://crm.example.com";
    const { absoluteUrl } = await loadAppUrl();

    const url = new URL(absoluteUrl(ROUTES.AUTH_CALLBACK));

    expect(url.origin).toBe("https://crm.example.com");
    expect(url.pathname).toBe("/auth/callback");
  });
});

describe("the routes the invitation needs actually exist", () => {
  it("names a callback and a password route", () => {
    expect(ROUTES.AUTH_CALLBACK).toBe("/auth/callback");
    expect(ROUTES.SET_PASSWORD).toBe("/auth/set-password");
  });

  it("has a real page file behind each one", async () => {
    /*
     * The 404 was a missing file, so the test for it is about files. A constant
     * pointing at a route that does not exist would reproduce the bug exactly.
     */
    const { access } = await import("node:fs/promises");

    await expect(access("src/app/(auth)/auth/callback/page.tsx")).resolves.toBeUndefined();
    await expect(access("src/app/(auth)/auth/set-password/page.tsx")).resolves.toBeUndefined();
  });
});

describe("middleware does not block the invitation", () => {
  it("exempts both invitation routes from redirection", () => {
    expect(AUTH_FLOW_ROUTES).toContain(ROUTES.AUTH_CALLBACK);
    expect(AUTH_FLOW_ROUTES).toContain(ROUTES.SET_PASSWORD);
  });

  it("keeps them out of PUBLIC_ROUTES, which would bounce them once signed in", () => {
    /*
     * The subtlety that makes a third category necessary. A PUBLIC_ROUTE
     * redirects an AUTHENTICATED user to the dashboard — and an invited person
     * IS authenticated by the time they reach the password page, so listing it
     * there would send them to the dashboard with no password set.
     */
    for (const route of AUTH_FLOW_ROUTES) {
      expect(PUBLIC_ROUTES).not.toContain(route);
    }
  });

  it("leaves the existing login flow exactly as it was", () => {
    /* Nothing about ordinary route protection may change. */
    expect(PUBLIC_ROUTES).toEqual([ROUTES.LOGIN]);
    expect(UNAUTHENTICATED_ENDPOINTS).toEqual(["/api/health"]);
    expect(DEFAULT_AUTHENTICATED_ROUTE).toBe(ROUTES.DASHBOARD);
  });

  it("checks the exemption AFTER the session refresh, so cookies survive", async () => {
    /*
     * Order matters and is easy to get wrong. Exempting before
     * `updateSupabaseSession` would skip the cookie refresh, and the password
     * page would then find no session and redirect to login — the 404 replaced
     * by a loop.
     */
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/proxy.ts", "utf8");

    expect(source.indexOf("updateSupabaseSession(request)")).toBeLessThan(
      source.indexOf("AUTH_FLOW_ROUTES.includes(pathname)"),
    );
  });

  it("does not widen the matcher or drop security headers for these routes", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/proxy.ts", "utf8");

    /* The exemption returns through withSecurityHeaders like every other path. */
    expect(source).toContain(
      "if (AUTH_FLOW_ROUTES.includes(pathname)) {\n    return withSecurityHeaders(response);",
    );
  });
});

describe("the invitation carries a redirect", () => {
  it("passes redirectTo to Supabase", async () => {
    /*
     * The root cause, asserted against the source. A mock of the Supabase admin
     * client would prove the call shape but not that this specific argument is
     * present, which is the entire defect.
     */
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/modules/users/services/users.service.ts", "utf8");

    expect(source).toContain("redirectTo: absoluteUrl(ROUTES.AUTH_CALLBACK)");
    /* And the bare call that caused the bug is gone. */
    expect(source).not.toContain("inviteUserByEmail(email)");
  });

  it("keeps the resend for earlier invitations, and creates new users directly", async () => {
    /*
     * ADR-014 superseded ADR-008 Decisions 2 and 3: new users are created with
     * `createUser` and a confirmed email. The invitation send survives only in
     * `resendInvite`, for people invited before the change — which is why the
     * callback and set-password routes stay.
     */
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/modules/users/services/users.service.ts", "utf8");

    expect(source.split("inviteUserByEmail(").length - 1).toBe(1);
    expect(source).toContain("inviteUserByEmail(target.email");
    expect(source).toContain("auth.admin.createUser({");
    expect(source).toContain("email_confirm: true");
  });
});

describe("the invitation cannot be edited into a promotion", () => {
  it("takes no role from the callback URL", async () => {
    /*
     * The role is chosen by the administrator at invite time and written to
     * public.users before the email is sent. If the callback read one from the
     * URL, a recipient could paste `&role=super_admin` and become one.
     */
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/app/(auth)/auth/callback/page.tsx", "utf8");

    expect(source).not.toMatch(/first\(\s*["']role["']\s*\)/);
    expect(source).not.toContain("USER_ROLES");
  });

  it("takes no email or role when setting the first password", async () => {
    /*
     * `updateUser` acts on whoever the SESSION says the caller is. An email
     * parameter here would let a recipient set someone else's password.
     */
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/modules/auth/services/auth.service.ts", "utf8");

    const fn = source.slice(source.indexOf("async function setInitialPassword"));
    const body = fn.slice(0, fn.indexOf("\nexport const authService"));

    expect(body).toContain("updateUser({\n      password:");
    expect(body).not.toContain("email:");
    expect(body).not.toContain("role");
  });

  it("refuses to set a password without a session", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/modules/auth/services/auth.service.ts", "utf8");

    const fn = source.slice(source.indexOf("async function setInitialPassword"));

    /* The session check precedes the update, not the other way round. */
    expect(fn.indexOf("if (!session.session)")).toBeLessThan(fn.indexOf("updateUser"));
    expect(fn).toContain("UnauthorizedError");
  });

  it("verifies the session server-side on the password page", async () => {
    /*
     * getUser(), not getSession(). This page decides whether to render a
     * password field, so it asks Supabase rather than believing a cookie the
     * browser could have written.
     */
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/app/(auth)/auth/set-password/page.tsx", "utf8");

    expect(source).toContain("supabase.auth.getUser()");
    /* Matched as a CALL: the comment above it explains why getSession is wrong
       here, and a bare substring check would trip over that explanation. */
    expect(source).not.toMatch(/auth.getSession()/);
    expect(source).toContain("redirect(ROUTES.LOGIN)");
  });
});

describe("the token is validated on the server", () => {
  it("exchanges a token_hash with verifyOtp rather than trusting it", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/app/(auth)/auth/callback/page.tsx", "utf8");

    expect(source).toContain("supabase.auth.verifyOtp({");
    expect(source).toContain("token_hash: tokenHash");
  });

  it("never logs the token or the session", async () => {
    const { readFile } = await import("node:fs/promises");

    for (const file of [
      "src/app/(auth)/auth/callback/page.tsx",
      "src/modules/auth/components/auth-callback-fragment.tsx",
      "src/modules/auth/services/auth.service.ts",
    ]) {
      const source = await readFile(file, "utf8");

      expect(source).not.toMatch(/console\.(log|info|warn|error|debug)/);
    }
  });

  it("clears the tokens out of the address bar once the session is stored", async () => {
    /* Otherwise they sit in browser history and in any shared screenshot. */
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/modules/auth/components/auth-callback-fragment.tsx", "utf8");

    expect(source).toContain("window.history.replaceState");
  });
});

describe("choosing the first password", () => {
  const schema = buildSetPasswordSchema(12);

  it("accepts a matching pair at the configured length", () => {
    const result = schema.safeParse({
      newPassword: "a-long-enough-passphrase",
      confirmPassword: "a-long-enough-passphrase",
    });

    expect(result.success).toBe(true);
  });

  it("enforces the CONFIGURED minimum, not a hardcoded one", () => {
    /*
     * `security.passwordMinLength` is editable on the Security page. A number
     * written into this schema would be a second policy free to disagree.
     */
    expect(
      buildSetPasswordSchema(20).safeParse({
        newPassword: "twelve-chars",
        confirmPassword: "twelve-chars",
      }).success,
    ).toBe(false);

    expect(
      buildSetPasswordSchema(8).safeParse({
        newPassword: "eight-ch",
        confirmPassword: "eight-ch",
      }).success,
    ).toBe(true);
  });

  it("rejects a mismatch, against the confirm field", () => {
    const result = schema.safeParse({
      newPassword: "a-long-enough-passphrase",
      confirmPassword: "a-different-passphrase",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["confirmPassword"]);
    }
  });

  it("refuses more than bcrypt's 72 bytes", () => {
    const long = "x".repeat(73);

    expect(schema.safeParse({ newPassword: long, confirmPassword: long }).success).toBe(false);
  });

  it("asks for no current password, which an invited user does not have", () => {
    /* The reason this schema exists instead of reusing the change-password one. */
    const result = schema.safeParse({
      newPassword: "a-long-enough-passphrase",
      confirmPassword: "a-long-enough-passphrase",
    });

    expect(result.success).toBe(true);
  });
});
