import "server-only";

import { cache } from "react";

import { isSupabaseConfigured } from "@/config/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { toAppUser, type AppUser } from "./app-user";

/**
 * Reads the current user on the server.
 *
 * Uses getUser(), which revalidates the token with Supabase, rather than
 * getSession(), which trusts a cookie the client controls. 01_MASTER_RULES.md:
 * never trust the frontend.
 *
 * Wrapped in React's `cache` so that all callers within one request share a
 * single result. Rendering /dashboard asks three times — the root layout, the
 * authenticated layout and the page itself — and each call is a network round
 * trip to Supabase. Deduplicating turns three into one, which matters against
 * the sub-second dashboard target in 01_MASTER_RULES.md. The cache is per
 * request, so one user's session is never served to another.
 *
 * Returns null rather than throwing, because "nobody is signed in" is a normal
 * state, not a failure.
 */
export const getCurrentUser = cache(async (): Promise<AppUser | null> => {
  /*
   * No credentials means no session to read. Skipping the call avoids a
   * guaranteed network failure; returning null is honest, not a bypass.
   */
  if (!isSupabaseConfigured()) {
    return null;
  }

  const supabase = await createSupabaseServerClient();

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    return toAppUser(user);
  } catch {
    return null;
  }
});
