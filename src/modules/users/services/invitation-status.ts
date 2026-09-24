/**
 * Whether somebody has actually accepted their invitation.
 *
 * THE CRM DOES NOT STORE THIS, and deliberately should not start.
 * `public.users.status` is active | suspended | disabled — an operational
 * status an administrator sets — and the pre-ADR-014 `invite()` wrote `active`
 * the moment the invitation was sent, so authorization existed before the person
 * first signed in. Nothing in that column has ever described an invitation.
 *
 * Since ADR-014 users are created directly, confirmed, and never invited, so
 * they read `accepted`. This remains for people invited before that change.
 *
 * The truth lives in Supabase's `auth.users`, which records both halves:
 *
 *   invited_at           when the invitation was sent
 *   email_confirmed_at   when they followed the link and proved the mailbox
 *
 * So this derives, it does not persist. A stored copy would be a fourth column
 * nothing maintains — the exact shape of bug this codebase has already been bitten
 * by four times (health_score, expiration_date, expiring_soon, accounts.status).
 */

export type InvitationState =
  /** Followed the link. A normal user; nothing to resend. */
  | "accepted"
  /** Invited, not yet accepted, still inside the link's lifetime. */
  | "pending"
  /** Invited, not accepted, and the link is old enough that it will be refused. */
  | "expired";

/**
 * How long a Supabase email link stays usable, in hours.
 *
 * This mirrors the project's `MAILER_OTP_EXP` (default 24h). It is NOT readable
 * through any API, so this constant is an estimate used for DISPLAY ONLY —
 * whether a link actually still works is decided by Supabase when the token is
 * presented, and `/auth/callback` already renders that answer.
 *
 * The consequence of the estimate being wrong is mild in both directions: too
 * short shows "Expired" while the link might still work, and resending is
 * harmless; too long shows "Pending" for a dead link, and the recipient sees the
 * expiry page that tells them to ask for a new one.
 */
export const INVITE_LINK_LIFETIME_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

export interface InvitationTimestamps {
  /** From auth.users.invited_at. Null for an account created directly. */
  readonly invitedAt: Date | null;
  /** From auth.users.email_confirmed_at. Non-null once the link was followed. */
  readonly acceptedAt: Date | null;
}

/**
 * Reads the two Supabase timestamps as one state.
 *
 * Acceptance wins over everything. The requirement "do not mark a normal active
 * user as expired" is enforced here rather than at each call site: an accepted
 * invitation is `accepted` no matter how old it is, and a user with no
 * `invited_at` at all — the original administrator, created directly rather than
 * invited — is `accepted` too, because there is no invitation to be pending on.
 */
export function deriveInvitationState(
  timestamps: InvitationTimestamps,
  now: Date = new Date(),
): InvitationState {
  if (timestamps.acceptedAt !== null) {
    return "accepted";
  }

  /*
   * No invitation on record. Not "pending": there is nothing outstanding, and
   * showing a Resend action here would offer to re-invite somebody who was
   * never invited in the first place.
   */
  if (timestamps.invitedAt === null) {
    return "accepted";
  }

  const ageHours = (now.getTime() - timestamps.invitedAt.getTime()) / HOUR_MS;

  return ageHours > INVITE_LINK_LIFETIME_HOURS ? "expired" : "pending";
}

/**
 * Whether a fresh invitation may be sent to this person.
 *
 * Both unaccepted states qualify, not only `expired`. An invitation that never
 * arrived — filtered, mistyped, sitting in a spam folder — leaves someone just
 * as stuck as one that timed out, and the operator cannot tell those apart from
 * the outside. What must never be offered is a resend to somebody who already
 * accepted, and that is the case this excludes.
 *
 * The server re-derives this before sending; the UI hiding the button is not
 * what enforces it.
 */
export function mayResendInvitation(state: InvitationState): boolean {
  return state !== "accepted";
}
