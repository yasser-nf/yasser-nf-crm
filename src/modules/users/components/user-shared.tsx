import { ROLE_LABELS, USER_STATUS_LABELS, type UserRole, type UserStatus } from "@/config/roles";
import type { InvitationState } from "../services/invitation-status";
import type { PresenceState } from "../services/presence";
import { cn } from "@/utils/cn";

/**
 * Shared user presentation.
 *
 * Every map is `Record<Union, …>`, so adding a role, status or presence state
 * without a colour becomes a compile error rather than an unstyled badge.
 */

const BADGE = "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-caption font-medium";

const ROLE_STYLES: Record<UserRole, string> = {
  super_admin: "bg-primary-subtle text-primary",
  worker: "bg-surface-raised text-foreground-muted",
};

export function RoleBadge({ role }: { role: UserRole }) {
  return <span className={cn(BADGE, ROLE_STYLES[role])}>{ROLE_LABELS[role]}</span>;
}

const STATUS_STYLES: Record<UserStatus, { className: string; dot: string }> = {
  active: { className: "bg-success-subtle text-success", dot: "bg-success" },
  suspended: { className: "bg-warning-subtle text-warning", dot: "bg-warning" },
  disabled: { className: "bg-danger-subtle text-danger", dot: "bg-danger" },
};

export function UserStatusBadge({
  status,
  archived = false,
}: {
  status: UserStatus;
  archived?: boolean;
}) {
  if (archived) {
    return (
      <span className={cn(BADGE, "bg-neutral-subtle text-foreground-subtle")}>
        <span className="size-1.5 shrink-0 rounded-full bg-neutral" aria-hidden="true" />
        Archived
      </span>
    );
  }

  const style = STATUS_STYLES[status];

  return (
    <span className={cn(BADGE, style.className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", style.dot)} aria-hidden="true" />
      {USER_STATUS_LABELS[status]}
    </span>
  );
}

const PRESENCE_STYLES: Record<PresenceState, { label: string; dot: string; text: string }> = {
  online: { label: "Online", dot: "bg-success", text: "text-success" },
  idle: { label: "Idle", dot: "bg-warning", text: "text-warning" },
  offline: { label: "Offline", dot: "bg-neutral", text: "text-foreground-subtle" },
};

/**
 * Presence indicator.
 *
 * Derived from Supabase session activity, never stored — see derivePresence.
 * Online means active within five minutes, idle within thirty.
 */
export function PresenceDot({ presence }: { presence: PresenceState }) {
  const style = PRESENCE_STYLES[presence];

  return (
    <span className={cn("inline-flex items-center gap-1.5 text-caption", style.text)}>
      <span className={cn("size-2 shrink-0 rounded-full", style.dot)} aria-hidden="true" />
      {style.label}
    </span>
  );
}

/** Turns a user agent into something a person can read. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) {
    return "Unknown device";
  }

  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "Unknown browser";

  const platform = /Windows/.test(userAgent)
    ? "Windows"
    : /Android/.test(userAgent)
      ? "Android"
      : /iPhone|iPad/.test(userAgent)
        ? "iOS"
        : /Mac OS X/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "Unknown OS";

  return `${browser} on ${platform}`;
}

export function formatDateTime(value: Date | string | null): string {
  return value
    ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";
}

/**
 * Whether somebody has accepted their invitation.
 *
 * A SEPARATE badge from `UserStatusBadge`, not a fourth value inside it. The two
 * answer different questions — that one is the operational status an
 * administrator sets, this one is whether the person ever finished signing up —
 * and a row can legitimately read "Active" and "Expired invitation" at once,
 * which is exactly the case the Resend action exists for.
 *
 * Nothing is rendered for an accepted invitation. Every established user would
 * otherwise carry a permanent "Accepted" chip that says nothing about them.
 */
export function InvitationBadge({ state }: { state: InvitationState }) {
  if (state === "accepted") {
    return null;
  }

  const style =
    state === "expired"
      ? { className: "bg-danger-subtle text-danger", dot: "bg-danger", label: "Expired" }
      : { className: "bg-warning-subtle text-warning", dot: "bg-warning", label: "Invited" };

  return (
    <span className={cn(BADGE, style.className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", style.dot)} aria-hidden="true" />
      {style.label}
    </span>
  );
}
