import { createServerClient } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { env, isSupabaseConfigured } from "@/config/env";

/**
 * Refreshes the Supabase session and reports who the request belongs to.
 *
 * Auth tokens expire. Without a refresh on each request the user is silently
 * signed out mid-session, so this runs in middleware before any route decision
 * is made.
 *
 * The returned response carries updated auth cookies and must be the response
 * that is eventually sent, or the refresh is lost.
 */
export async function updateSupabaseSession(request: NextRequest): Promise<{
  response: NextResponse;
  user: User | null;
}> {
  let response = NextResponse.next({ request });

  /*
   * Without real credentials there is no session to refresh, and the request
   * below would resolve a hostname that does not exist — a failed network round
   * trip on every single request, including every navigation.
   *
   * Returning `user: null` is honest rather than a bypass: nobody is signed in,
   * so route protection denies access and redirects to login. A misconfigured
   * production deployment therefore locks everyone out, which is the safe
   * direction to fail. No session is ever fabricated.
   */
  if (!isSupabaseConfigured()) {
    return { response, user: null };
  }

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }

          response = NextResponse.next({ request });

          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  /*
   * getUser() revalidates the token with Supabase. getSession() only reads the
   * cookie, which the client controls — 01_MASTER_RULES.md says never trust the
   * frontend, so the authoritative check is used here.
   *
   * A network failure must not lock everyone out of the application, so an
   * unreachable auth service is treated as "not signed in" and the request
   * continues to the login page rather than erroring.
   */
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    return { response, user };
  } catch {
    return { response, user: null };
  }
}
