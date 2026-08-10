import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { BackupDetailView, backupService } from "@/modules/backups";
import { usersService } from "@/modules/users";
import { ErrorState } from "@/shared/feedback/error-state";

export const metadata: Metadata = { title: "Backup" };

/**
 * Backup detail and restore.
 *
 * Authorization belongs to the service. This page renders whatever the service
 * returns, including its refusals.
 */
export default async function BackupDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getCurrentUser();

  const result = await backupService.getDetail(id, actor);

  if (!result.ok) {
    if (result.error instanceof ForbiddenError) {
      return (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-16 text-center">
          <ShieldAlert className="size-6 text-foreground-subtle" aria-hidden="true" />
          <h2 className="text-section-title text-foreground">Not available to your role</h2>
          <p className="max-w-sm text-description text-foreground-muted">
            Backups are restricted to Super Admins.
          </p>
        </div>
      );
    }

    if (result.error instanceof NotFoundError) {
      notFound();
    }

    return <ErrorState error={result.error} title="Could not load this backup" />;
  }

  /*
   * The creator's name comes from the users module's public API rather than a
   * join here — the backups module does not own user data, and reaching into
   * another module's tables would couple them.
   */
  let createdByName: string | null = null;

  if (result.value.createdBy) {
    const creator = await usersService.getDetail(result.value.createdBy, actor);
    createdByName = creator.ok ? creator.value.user.name : null;
  }

  return <BackupDetailView backup={result.value} createdByName={createdByName} />;
}
