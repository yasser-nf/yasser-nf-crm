"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ROUTES } from "@/config/constants";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Skeleton } from "@/shared/ui/skeleton";

/**
 * Finishes an invitation whose session arrived in the URL fragment.
 *
 * Supabase's default email template routes the recipient through its own
 * `/auth/v1/verify` endpoint. That endpoint validates the invitation token on
 * Supabase's servers and then redirects here with the resulting session after a
 * `#`. A fragment is never transmitted to a server, so this last step cannot
 * happen anywhere but the browser.
 *
 * What is in the fragment is a session Supabase has already issued — not the
 * invitation token, which was spent before the redirect. Handing it to
 * `setSession` writes the auth cookies through `@supabase/ssr`, which is what
 * makes the following page server-authenticated.
 *
 * Nothing here decides anything about the user. It moves an already-issued
 * session from the URL into cookies, and every page after this asks the server
 * who that session belongs to.
 */

/** Kept out of the logs and out of state. Read once, then removed from the URL. */
function readFragment(): Record<string, string> {
  if (typeof window === "undefined" || !window.location.hash) {
    return {};
  }

  return Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)));
}

export function AuthCallbackFragment() {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    /*
     * One async path for every outcome, rather than a synchronous branch for
     * errors and an async one for success.
     *
     * The fragment can only be read after mount — it does not exist during
     * server rendering — so this cannot be derived during render. Keeping both
     * outcomes on the same path means the page shows "Confirming…" first in
     * every case, instead of flashing an error into the hydrated markup.
     */
    void (async () => {
      const params = readFragment();
      const error = params["error_description"] ?? params["error_code"] ?? params["error"];

      if (error) {
        if (!cancelled) {
          setFailure(
            error.toLowerCase().includes("expired")
              ? "This invitation link has expired or has already been used. Ask an administrator to send you a new one."
              : "This invitation link could not be verified. Ask an administrator to send you a new one.",
          );
        }
        return;
      }

      const accessToken = params["access_token"];
      const refreshToken = params["refresh_token"];

      if (!accessToken || !refreshToken) {
        /*
         * Neither a session nor an error — somebody opened /auth/callback
         * directly. Nothing to explain, and nothing to do.
         */
        router.replace(ROUTES.LOGIN);
        return;
      }

      const supabase = createSupabaseBrowserClient();
      const { error: sessionError } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      if (cancelled) return;

      if (sessionError) {
        setFailure("Your invitation could not be completed. Ask an administrator to resend it.");
        return;
      }

      /*
       * Clears the tokens out of the address bar before navigating, so they are
       * not left in browser history or leaked by a shared screenshot.
       */
      window.history.replaceState(null, "", window.location.pathname);

      /* refresh() so the server re-reads the cookies setSession just wrote. */
      router.replace(ROUTES.SET_PASSWORD);
      router.refresh();
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (failure) {
    return (
      <p className="text-description text-danger" role="alert">
        {failure}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <p className="text-description text-foreground-muted">Confirming your invitation…</p>
      <Skeleton className="h-11 w-full" />
    </div>
  );
}
