import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ROUTES } from "@/config/constants";
import { isInvitationConfigured } from "@/config/env.server";
import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import { InviteUserForm } from "@/modules/users";

export const metadata: Metadata = { title: "Invite user" };

/**
 * Invite a user.
 *
 * ADR-008 Decision 3: the only way a user is created. No password is collected
 * here or anywhere else.
 *
 * The permission check below only decides whether to render the form. The
 * service refuses the invitation independently, so a Worker who posts to the
 * action directly is still refused.
 */
export default async function NewUserPage() {
  const actor = await getCurrentUser();
  const permitted = actor !== null && roleHasPermission(actor.role, PERMISSIONS.MANAGE_USERS);

  if (!permitted) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-16 text-center">
        <ShieldAlert className="size-6 text-foreground-subtle" aria-hidden="true" />
        <h1 className="text-section-title text-foreground">Not available to your role</h1>
        <p className="max-w-sm text-description text-foreground-muted">
          Inviting users is restricted to Super Admins.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href={ROUTES.USERS}
          className="inline-flex w-fit items-center gap-1.5 text-caption text-foreground-muted hover:text-foreground"
        >
          &larr; All users
        </Link>
        <h1 className="text-page-title text-foreground">Invite a user</h1>
        <p className="text-description text-foreground-muted">
          They receive an email, choose their own password, and appear here once they sign in.
        </p>
      </div>

      <InviteUserForm invitationsConfigured={isInvitationConfigured()} />
    </div>
  );
}
