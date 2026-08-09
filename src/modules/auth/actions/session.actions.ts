"use server";

import { getCurrentUser, recordSuccessfulLogin } from "@/lib/auth/session";

/**
 * Records that the signed-in user has just authenticated.
 *
 * Called from the login hook after Supabase accepts the credentials. It cannot
 * be used to fake a login: it records the identity of whoever the server
 * resolves from the session cookie, ignoring anything the caller passes. A
 * failed sign-in has no session, so there is nothing to record.
 *
 * Returns nothing. A stored timestamp is not worth failing a successful login
 * over, and the caller has no decision to make with the outcome.
 */
export async function recordLoginAction(): Promise<void> {
  const user = await getCurrentUser();

  if (!user) {
    return;
  }

  await recordSuccessfulLogin(user.id);
}
