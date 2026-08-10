import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/config/env";
import { isInvitationConfigured, serverEnv } from "@/config/env.server";
import { ConfigurationError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";

/**
 * Supabase admin client.
 *
 * Uses the service role key, which bypasses Row Level Security completely. It
 * is the most dangerous credential in the project: anything holding it has
 * unrestricted access to every table regardless of the policies from migration
 * 0002.
 *
 * Two structural guards, not conventions:
 *
 *   1. `server-only` at the top. If any client component ever imports this
 *      module — directly or through a barrel — the build fails rather than
 *      shipping the key to a browser.
 *   2. The key is read from `config/env.server`, which carries the same guard.
 *      It is never placed in `config/env.ts`, so it cannot be inlined into the
 *      client bundle by Next's NEXT_PUBLIC substitution.
 *
 * Used for exactly one thing: sending invitations. Every other database
 * operation goes through the Database Adapter as `postgres`, which is already
 * privileged and does not need this key.
 */

/**
 * Builds an admin client, or explains why it cannot.
 *
 * Returns a Result rather than throwing so a missing key surfaces as a
 * configuration message on the invite form instead of a crashed request.
 */
export function createSupabaseAdminClient(): Result<SupabaseClient> {
  if (!isInvitationConfigured()) {
    return fail(
      new ConfigurationError("SUPABASE_SERVICE_ROLE_KEY is not set", {
        userMessage:
          "Invitations are unavailable until the Supabase service role key is configured.",
      }),
    );
  }

  const serviceRoleKey = serverEnv.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey) {
    return fail(new ConfigurationError("SUPABASE_SERVICE_ROLE_KEY is empty"));
  }

  return ok(
    createClient(env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey, {
      auth: {
        /*
         * No session handling at all. This client acts as the service, never as
         * a person, and persisting or refreshing a session for it would attach
         * service-role authority to something that outlives the request.
         */
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    }),
  );
}
