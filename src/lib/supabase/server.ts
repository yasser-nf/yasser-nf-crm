import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { env } from "@/config/env";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * A new client is created per request. Sharing one across requests would leak
 * one user's session into another's response.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          /*
           * Server Components cannot set cookies. This is expected and safe to
           * ignore: middleware refreshes the session on every request, so the
           * cookie is already current by the time rendering happens.
           */
        }
      },
    },
  });
}
