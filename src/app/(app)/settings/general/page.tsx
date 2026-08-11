import type { Metadata } from "next";
import { Suspense } from "react";

import { SettingsCategorySection } from "@/modules/settings";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "General settings" };

/** Route composition only. The section loads itself through the service. */
export default function GeneralSettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <SettingsCategorySection
        category="general"
        title="General"
        description="Application name, timezone, date format, language and currency."
      />
    </Suspense>
  );
}
