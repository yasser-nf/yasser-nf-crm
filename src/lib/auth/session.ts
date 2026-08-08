import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { toAppUser, type AppUser } from "./app-user";

/**
 * Reads the current user on the server.
 *
 * Uses getUser(), which revalidates the token with Supabase, rather than
 * getSession(), which trusts a cookie the client controls. 01_MASTER_RULES.md:
 * never trust the frontend.
 *
 * Returns null rather than throwing, because "nobody is signed in" is a normal
 * state, not a failure.
 */
export async function getCurrentUser(): Promise<AppUser | null> {
  const supabase = await createSupabaseServerClient();

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    return toAppUser(user);
  } catch {
    return null;
  }
}
