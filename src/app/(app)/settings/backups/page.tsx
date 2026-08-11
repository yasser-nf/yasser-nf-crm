import type { Metadata } from "next";
import { Suspense } from "react";

import { SettingsCategorySection } from "@/modules/settings";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Backups settings" };

/** Route composition only. The section loads itself through the service. */
export default function BackupsSettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <SettingsCategorySection
        category="backups"
        title="Backups"
        description="Automatic schedule and retention. The backups module reads these values."
      />
    </Suspense>
  );
}
