import "server-only";

import { eq } from "drizzle-orm";
import { cache } from "react";

import { isSupabaseConfigured } from "@/config/env";
import { databaseAdapter } from "@/lib/database";
import { users } from "@/lib/drizzle/schema";
import { logger } from "@/lib/logger";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { toAppUser, toAuthIdentity, type AppUser } from "./app-user";

/**
 * Reads the current user on the server.
 *
 * Two independent gates, both required:
 *
 *   1. A valid Supabase Auth session. getUser() revalidates the token with
 *      Supabase rather than trusting a cookie the client controls —
 *      01_MASTER_RULES.md: never trust the frontend.
 *
 *   2. An active public.users record. ADR-005 Decision 3 makes that table the
 *      authoritative source of role.
 *
 * The second gate matters on its own. Anyone who can create a Supabase Auth
 * identity — through a sign-up flow, an invite, or the dashboard — would
 * otherwise be a valid session with no CRM record. Requiring the row means an
 * auth identity alone grants nothing.
 *
 * A disabled or soft-deleted user is refused for the same reason: revoking
 * access must not require also deleting their auth identity, or revocation
 * would destroy the audit trail.
 *
 * Wrapped in React's `cache` so all callers in one request share a single
 * lookup. Rendering an authenticated page asks three times; this makes it one.
 */
export const getCurrentUser = cache(async (): Promise<AppUser | null> => {
  if (!isSupabaseConfigured()) {
    return null;
  }

  const supabase = await createSupabaseServerClient();

  let identity: ReturnType<typeof toAuthIdentity> = null;

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    identity = toAuthIdentity(user);
  } catch {
    return null;
  }

  if (!identity) {
    return null;
  }

  const record = await databaseAdapter.query("auth.loadCrmUser", (executor) =>
    executor
      .select({
        name: users.name,
        role: users.role,
        status: users.status,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.id, identity.id))
      .limit(1),
  );

  if (!record.ok) {
    /*
     * Fail closed. A database problem must not become an authorization bypass,
     * so an unreadable role is treated as no access rather than as a default.
     */
    logger.error("Could not resolve CRM record for an authenticated identity", record.error, {
      userId: identity.id,
    });
    return null;
  }

  const crmUser = record.value[0];

  if (!crmUser || crmUser.deletedAt !== null || crmUser.status !== "active") {
    logger.warn("Authenticated identity has no active CRM record", { userId: identity.id });
    return null;
  }

  return toAppUser(identity, { name: crmUser.name, role: crmUser.role });
});

/**
 * Records a successful sign-in.
 *
 * Called only after Supabase has accepted the credentials, so a failed attempt
 * can never be written as a login. Failures are swallowed: a login is not worth
 * refusing because a timestamp could not be stored.
 */
export async function recordSuccessfulLogin(userId: string): Promise<void> {
  const result = await databaseAdapter.query("auth.recordLogin", (executor) =>
    executor
      .update(users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id }),
  );

  if (!result.ok) {
    logger.warn("Could not record last_login_at", { userId, code: result.error.code });
  }
}
