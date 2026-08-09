import type { User } from "@supabase/supabase-js";

import type { UserRole } from "@/config/roles";

/**
 * The application's view of a signed-in person.
 *
 * Deliberately narrower than Supabase's `User`. Components should never see raw
 * provider tokens, app metadata or identity records.
 *
 * `role` comes from public.users, which ADR-005 Decision 3 made the authoritative
 * location. It is deliberately NOT read from Supabase Auth metadata: that would
 * be a second copy, and a copy of an authorization decision is a copy that can
 * disagree with the real one.
 */
export interface AppUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  /** Up to two letters for the avatar fallback. */
  readonly initials: string;
  readonly role: UserRole;
}

/** The identity half, before the CRM record is joined on. */
export interface AuthIdentity {
  readonly id: string;
  readonly email: string;
}

function deriveDisplayName(email: string): string {
  const localPart = email.split("@")[0] ?? email;

  return localPart
    .split(/[._-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function deriveInitials(displayName: string): string {
  const words = displayName.split(" ").filter((word) => word.length > 0);

  if (words.length === 0) {
    return "?";
  }

  const first = words[0]?.charAt(0) ?? "";
  const second = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? "") : "";

  return (first + second).toUpperCase();
}

/**
 * Extracts the identity from a Supabase user.
 *
 * Returns null when the record has no email. Supabase types `email` as optional
 * because other sign-in methods exist, but this application authenticates by
 * email and password only.
 *
 * Deliberately does NOT produce an AppUser: a person is not a CRM user until a
 * public.users row says so, and that lookup is server-side.
 */
export function toAuthIdentity(user: User | null): AuthIdentity | null {
  if (!user?.email) {
    return null;
  }

  return { id: user.id, email: user.email };
}

/** Builds an AppUser from an identity and its CRM record. */
export function toAppUser(
  identity: AuthIdentity,
  crmRecord: { name: string; role: UserRole },
): AppUser {
  const displayName = crmRecord.name.trim() || deriveDisplayName(identity.email);

  return {
    id: identity.id,
    email: identity.email,
    displayName,
    initials: deriveInitials(displayName),
    role: crmRecord.role,
  };
}
