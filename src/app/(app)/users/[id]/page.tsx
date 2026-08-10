import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { UserDetailView, usersService } from "@/modules/users";
import { ErrorState } from "@/shared/feedback/error-state";

export const metadata: Metadata = { title: "User" };

/**
 * User details.
 *
 * Sessions, activity and login history are loaded by the service in parallel —
 * one query each, none scaling with the number of rows.
 */
export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getCurrentUser();

  const detail = await usersService.getDetail(id, actor);

  if (!detail.ok) {
    if (detail.error instanceof NotFoundError) {
      notFound();
    }

    if (detail.error instanceof ForbiddenError) {
      return (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-16 text-center">
          <ShieldAlert className="size-6 text-foreground-subtle" aria-hidden="true" />
          <h1 className="text-section-title text-foreground">Not available to your role</h1>
          <p className="max-w-sm text-description text-foreground-muted">
            User management is restricted to Super Admins.
          </p>
        </div>
      );
    }

    return <ErrorState error={detail.error} title="Could not load this user" />;
  }

  return <UserDetailView detail={detail.value} isSelf={actor?.id === id} />;
}
