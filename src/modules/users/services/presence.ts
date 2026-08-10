/**
 * Presence, derived from session activity.
 *
 * Its own module because it is pure — no database, no clock of its own — and
 * therefore testable without a server environment. `users.service.ts` imports
 * `server-only`, so anything living there cannot be unit tested.
 *
 * Presence is never stored. A `last_seen` column would need writing on every
 * request — a write per page view to answer a question nobody asks most of the
 * time — and would still be stale the moment a process died. Session activity
 * already records what is needed, so this reads it rather than duplicating it.
 */

export type PresenceState = "online" | "idle" | "offline";

/** Active within five minutes. */
const ONLINE_WINDOW_MS = 5 * 60_000;

/** Active within thirty minutes. */
const IDLE_WINDOW_MS = 30 * 60_000;

export function derivePresence(lastActiveAt: Date | null, now: Date): PresenceState {
  if (!lastActiveAt) {
    return "offline";
  }

  const elapsed = now.getTime() - lastActiveAt.getTime();

  /*
   * Negative elapsed means the timestamp is ahead of our clock — ordinary skew
   * between the database and the application. Treated as online, because the
   * session demonstrably exists and reading it as offline would be worse.
   */
  if (elapsed <= ONLINE_WINDOW_MS) return "online";
  if (elapsed <= IDLE_WINDOW_MS) return "idle";
  return "offline";
}
