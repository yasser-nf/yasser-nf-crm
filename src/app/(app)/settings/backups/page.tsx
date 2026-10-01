import type { Metadata } from "next";
import { Suspense } from "react";

import { getCurrentUser } from "@/lib/auth/session";
import { backupService, BackupSchedulerStatus, scheduleEnforcement } from "@/modules/backups";
import { SettingsCategorySection } from "@/modules/settings";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Backups settings" };

/** Route composition only. The section loads itself through the service. */
export default function BackupsSettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <BackupsSettings />
    </Suspense>
  );
}

/**
 * The settings, beside the scheduler that acts on them. The backups module
 * measures the scheduler; the settings module renders whatever it is handed.
 * A refused or failed read leaves the catalogue's own "not enforced" note.
 */
async function BackupsSettings() {
  const status = await backupService.schedulerStatus(await getCurrentUser());

  return (
    <SettingsCategorySection
      category="backups"
      title="Backups"
      description="Automatic schedule and retention. The backups module reads these values."
      enforcement={status.ok ? scheduleEnforcement(status.value) : undefined}
      status={status.ok ? <BackupSchedulerStatus status={status.value} /> : null}
    />
  );
}
