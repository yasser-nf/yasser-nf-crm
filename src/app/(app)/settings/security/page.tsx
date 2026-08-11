import type { Metadata } from "next";
import { Suspense } from "react";

import { SettingsCategorySection } from "@/modules/settings";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Security settings" };

/** Route composition only. The section loads itself through the service. */
export default function SecuritySettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <SettingsCategorySection
        category="security"
        title="Security"
        description="Sessions, password policy and account locking. Several are enforced by Supabase Auth."
      />
    </Suspense>
  );
}
