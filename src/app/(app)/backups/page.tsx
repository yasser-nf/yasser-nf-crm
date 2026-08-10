import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { PAGINATION } from "@/config/constants";
import { isBackupStorageConfigured } from "@/config/env.server";
import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/errors";
import { BackupsTable, CreateBackupControls, backupService } from "@/modules/backups";
import { ErrorState } from "@/shared/feedback/error-state";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Backups" };

/**
 * Backups list.
 *
 * The service performs the authorization check, so a Worker reaching this URL
 * gets a refusal from the same code path a direct Server Action call would hit.
 * The page renders that refusal rather than deciding anything itself.
 */
export default async function BackupsPage() {
  const storageReady = isBackupStorageConfigured();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-page-title text-foreground">Backups</h1>
          <p className="text-description text-foreground-muted">
            Point-in-time copies of every account, profile, customer and user in the CRM.
          </p>
        </div>

        <CreateBackupControls storageReady={storageReady} />
      </header>

      {!storageReady ? (
        <p className="rounded-md border border-warning/30 bg-warning-subtle px-4 py-3 text-caption text-foreground-muted">
          Backup storage is unavailable until{" "}
          <code className="font-mono">SUPABASE_SERVICE_ROLE_KEY</code> is configured.
        </p>
      ) : null}

      <Suspense fallback={<TableSkeleton />}>
        <BackupsList />
      </Suspense>
    </div>
  );
}

async function BackupsList() {
  const actor = await getCurrentUser();
  const result = await backupService.list(
    { limit: PAGINATION.DEFAULT_PAGE_SIZE, offset: 0 },
    actor,
  );

  if (!result.ok) {
    /*
     * A refusal is not an error state. Showing "something went wrong" to a
     * Worker who simply lacks permission would send them chasing a bug.
     */
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

    return <ErrorState error={result.error} title="Could not load backups" />;
  }

  return <BackupsTable items={result.value.items} />;
}

/** 04_UI_GUIDELINES.md: skeletons, never spinners, matching the real layout. */
function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-11 w-full" />
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  );
}
