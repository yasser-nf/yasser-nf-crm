import type { Metadata } from "next";
import { Suspense } from "react";

import { SettingsCategorySection } from "@/modules/settings";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Company settings" };

/** Route composition only. The section loads itself through the service. */
export default function CompanySettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <SettingsCategorySection
        category="company"
        title="Company"
        description="Details shown on printed reports and used as contact information."
      />
    </Suspense>
  );
}
