import { createBrowserClient } from "@supabase/ssr";

import { env } from "@/config/env";

/**
 * Supabase client for the browser.
 *
 * Uses the anon key only. ADR-001: only NEXT_PUBLIC variables may reach the
 * browser, and the service key must never be exposed.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
