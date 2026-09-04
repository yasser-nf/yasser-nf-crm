import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ROUTES } from "@/config/constants";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AuthCallbackFragment } from "@/modules/auth";

import { AuthFlowShell } from "../../auth-flow-shell";

export const metadata: Metadata = {
  title: "Accepting your invitation",
};

/**
 * Where Supabase returns an invited person.
 *
 * It has to cope with two link shapes, because Supabase decides which one it
 * sends and the choice lives in an email template rather than in this codebase:
 *
 *   ?token_hash=…&type=invite   the template points straight here. The token is
 *                               verified BY THIS SERVER, below. Preferred, and
 *                               the one the deployment notes ask for.
 *
 *   #access_token=…             the default template sends the browser through
 *                               Supabase's own /auth/v1/verify, which validates
 *                               the invitation on Supabase's servers and then
 *                               redirects here with the resulting session in the
 *                               URL fragment. A fragment is never sent to a
 *                               server, so that case is finished in the browser
 *                               by `AuthCallbackFragment`.
 *
 * Either way the invitation itself is validated server-side — here, or by
 * Supabase before the redirect. Nothing in this page trusts a value from the
 * URL to decide who somebody is or what they may do. In particular there is no
 * role here: the role was chosen by the administrator at invite time and is
 * already written to `public.users`, so a recipient editing this URL changes
 * nothing about their permissions.
 */
export default async function AuthCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (key: string): string | null => {
    const value = params[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  /*
   * Supabase reports a dead link by redirecting with these, rather than by
   * failing the request. An expired or already-accepted invitation arrives
   * here, and must read as an explanation instead of a 404.
   */
  const errorCode = first("error_code") ?? first("error");

  if (errorCode) {
    return (
      <AuthFlowShell
        title="This invitation cannot be used"
        description={describeAuthError(errorCode, first("error_description"))}
        tone="error"
        action={{ href: ROUTES.LOGIN, label: "Go to sign in" }}
      />
    );
  }

  const tokenHash = first("token_hash");
  const type = first("type");

  if (tokenHash) {
    const supabase = await createSupabaseServerClient();

    /*
     * The server-side exchange. `verifyOtp` checks the token against Supabase
     * and, on success, writes the session cookies through the SSR client — so
     * the browser is signed in without the token ever being handled by client
     * code. It also consumes the token, which is what makes a second click on
     * the same link fail rather than sign someone in twice.
     */
    const { error } = await supabase.auth.verifyOtp({
      type: type === "recovery" ? "recovery" : "invite",
      token_hash: tokenHash,
    });

    if (error) {
      return (
        <AuthFlowShell
          title="This invitation cannot be used"
          /* Supabase's own wording. It knows whether this was expiry or reuse. */
          description={describeAuthError(String(error.status ?? ""), error.message)}
          tone="error"
          action={{ href: ROUTES.LOGIN, label: "Go to sign in" }}
        />
      );
    }

    redirect(ROUTES.SET_PASSWORD);
  }

  /*
   * No query parameters at all means the session is in the fragment, which only
   * the browser can read. Rendered as a client island rather than redirected:
   * a redirect would drop the fragment and lose the invitation.
   */
  return (
    <AuthFlowShell title="Accepting your invitation">
      <AuthCallbackFragment />
    </AuthFlowShell>
  );
}

/**
 * Turns Supabase's error vocabulary into something an invited person can act on.
 *
 * Its own message is shown when there is one — it distinguishes an expired link
 * from an already-used one, and inventing wording here would flatten that.
 */
function describeAuthError(code: string, description: string | null): string {
  if (code === "otp_expired" || description?.toLowerCase().includes("expired")) {
    return "This invitation link has expired or has already been used. Ask an administrator to send you a new one.";
  }

  if (code === "access_denied") {
    return "This invitation link is no longer valid. Ask an administrator to send you a new one.";
  }

  return (
    description ??
    "This invitation link could not be verified. Ask an administrator to send you a new one."
  );
}
