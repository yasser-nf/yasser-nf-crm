import type { Metadata } from "next";
import { Suspense } from "react";

import { SettingsCategorySection } from "@/modules/settings";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Notifications settings" };

/** Route composition only. The section loads itself through the service. */
export default function NotificationsSettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <SettingsCategorySection
        category="notifications"
        title="Notifications"
        description="What the system would tell you about, once a delivery mechanism exists."
      />
    </Suspense>
  );
}
