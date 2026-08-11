import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

import { USER_ROLES } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import { SettingsNav, type SettingsCategory } from "@/modules/settings";

/**
 * Settings shell.
 *
 * The category nav is shared by every settings page, so it lives in a layout
 * rather than being repeated seven times.
 *
 * Which categories appear is decided here, once. A Worker sees only the two
 * that contain nothing sensitive — the rest are absent from the markup, not
 * merely unstyled, so the nav cannot advertise a page they would be refused.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const actor = await getCurrentUser();

  if (!actor) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-16 text-center">
        <ShieldAlert className="size-6 text-foreground-subtle" aria-hidden="true" />
        <h1 className="text-section-title text-foreground">Sign in to view settings</h1>
      </div>
    );
  }

  const isSuperAdmin = actor.role === USER_ROLES.SUPER_ADMIN;

  const visible: SettingsCategory[] = isSuperAdmin
    ? ["general", "company", "security", "backups", "notifications", "system"]
    : ["general", "company"];

  return (
    <div className="flex flex-col gap-6">
      <SettingsNav visible={visible} />
      {children}
    </div>
  );
}
