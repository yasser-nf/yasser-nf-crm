import type { User } from "@supabase/supabase-js";

/**
 * The application's view of a signed-in person.
 *
 * Deliberately narrower than Supabase's `User`. Components should never see raw
 * provider tokens, app metadata or identity records, so the shape they receive
 * contains only what the interface actually renders.
 *
 * There is no `role` field yet. ADR-003 defers role storage until 03_DATABASE.md
 * defines the users table — inventing a default here would be guessing at the
 * data model, which 01_MASTER_RULES.md forbids. The field joins this type when
 * the database document exists.
 */
export interface AppUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  /** Up to two letters for the avatar fallback. */
  readonly initials: string;
}

function deriveDisplayName(email: string): string {
  const localPart = email.split("@")[0] ?? email;

  return localPart
    .split(/[._-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function deriveInitials(displayName: string): string {
  const words = displayName.split(" ").filter((word) => word.length > 0);

  if (words.length === 0) {
    return "?";
  }

  const first = words[0]?.charAt(0) ?? "";
  const second = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? "") : "";

  return (first + second).toUpperCase();
}

/**
 * Maps a Supabase user onto the application's shape.
 *
 * Returns null when the record has no email. Supabase types `email` as optional
 * because other sign-in methods exist, but this application authenticates by
 * email and password only, so a user without one cannot be represented.
 */
export function toAppUser(user: User | null): AppUser | null {
  if (!user?.email) {
    return null;
  }

  const displayName = deriveDisplayName(user.email);

  return {
    id: user.id,
    email: user.email,
    displayName,
    initials: deriveInitials(displayName),
  };
}
