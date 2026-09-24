import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ROUTES } from "@/config/constants";
import { isUserCreationConfigured } from "@/config/env.server";
import { getCurrentUser } from "@/lib/auth/session";
import { configurationService } from "@/modules/settings";
import { CreateUserForm, assignableRoles } from "@/modules/users";

export const metadata: Metadata = { title: "Create user" };

/**
 * Create a user. ADR-014: directly, with a password, usable at once.
 *
 * The permission check below only decides whether to render the form. The
 * service refuses the creation independently — including a role the actor may
 * not assign — so a Worker who posts to the action directly is still refused.
 *
 * The password policy is read here from the same configured value the service
 * enforces, so the hint and the client rule cannot disagree with the server.
 */
export default async function NewUserPage() {
  const actor = await getCurrentUser();
  const roles = actor === null ? [] : assignableRoles(actor.role);

  if (roles.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-16 text-center">
        <ShieldAlert className="size-6 text-foreground-subtle" aria-hidden="true" />
        <h1 className="text-section-title text-foreground">Not available to your role</h1>
        <p className="max-w-sm text-description text-foreground-muted">
          Creating users is restricted to Super Admins.
        </p>
      </div>
    );
  }

  const security = await configurationService.security();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href={ROUTES.USERS}
          className="inline-flex w-fit items-center gap-1.5 text-caption text-foreground-muted hover:text-foreground"
        >
          &larr; All users
        </Link>
        <h1 className="text-page-title text-foreground">Create a user</h1>
        <p className="text-description text-foreground-muted">
          They can sign in straight away with the email and password you set here.
        </p>
      </div>

      <CreateUserForm
        assignableRoles={roles}
        passwordMinLength={security.passwordMinLength}
        creationConfigured={isUserCreationConfigured()}
      />
    </div>
  );
}
