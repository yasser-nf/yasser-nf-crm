"use server";

import { headers } from "next/headers";

import { getCurrentUser, recordSuccessfulLogin } from "@/lib/auth/session";
import { activityService } from "@/modules/users";

/**
 * Auth event recording.
 *
 * These write `login_history`, the table M06 added because Supabase's own
 * `auth.audit_log_entries` was measured empty — 0 rows against 12 live refresh
 * tokens — so depending on it would have produced a permanently blank screen.
 *
 * All three return nothing. A history row is never worth failing a sign-in or a
 * sign-out over, and the caller has no decision to make with the outcome.
 */

/** Best-effort request metadata. Absent behind some proxies; never fabricated. */
async function requestContext(): Promise<{ ipAddress?: string; userAgent?: string }> {
  const headerList = await headers();

  /*
   * x-forwarded-for is a list, client first. Taking the last entry would record
   * the proxy rather than the person.
   */
  const forwarded = headerList.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || headerList.get("x-real-ip") || null;
  const agent = headerList.get("user-agent");

  return {
    ...(ip ? { ipAddress: ip } : {}),
    ...(agent ? { userAgent: agent } : {}),
  };
}

/**
 * Records that the signed-in user has just authenticated.
 *
 * Called from the login hook after Supabase accepts the credentials. It cannot
 * be used to fake a login: it records the identity of whoever the server
 * resolves from the session cookie, ignoring anything the caller passes. A
 * failed sign-in has no session, so there is nothing to record here.
 */
export async function recordLoginAction(): Promise<void> {
  const user = await getCurrentUser();

  if (!user) {
    return;
  }

  await recordSuccessfulLogin(user.id);

  await activityService.recordAuthEvent({
    userId: user.id,
    email: user.email,
    eventType: "login_success",
    ...(await requestContext()),
  });
}

/**
 * Records a sign-out.
 *
 * Must run before `supabase.auth.signOut()`, because afterwards there is no
 * session left to resolve an identity from.
 */
export async function recordLogoutAction(): Promise<void> {
  const user = await getCurrentUser();

  if (!user) {
    return;
  }

  await activityService.recordAuthEvent({
    userId: user.id,
    email: user.email,
    eventType: "logout",
    ...(await requestContext()),
  });
}

/**
 * Records a rejected sign-in attempt.
 *
 * `userId` stays null and only the attempted address is kept — the address may
 * match no user at all, which is why both columns are nullable. The reason is
 * never the password or anything derived from it.
 *
 * Known limitation: this is reachable without a session, because a failed
 * sign-in by definition has none. Someone who knows the endpoint could write
 * rows into `login_history`. That is accepted for now — the alternative is not
 * recording failed attempts, which are the entries most worth having — but it
 * wants a rate limit before this is exposed beyond a private deployment.
 */
export async function recordFailedLoginAction(email: string): Promise<void> {
  const attempted = email.trim().toLowerCase().slice(0, 255);

  if (!attempted) {
    return;
  }

  await activityService.recordAuthEvent({
    userId: null,
    email: attempted,
    eventType: "login_failed",
    failureReason: "invalid credentials",
    ...(await requestContext()),
  });
}
