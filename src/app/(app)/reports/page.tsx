import type { Metadata } from "next";
import { Suspense } from "react";

import { getCurrentUser } from "@/lib/auth/session";
import { ReportsCatalogue, reportsService } from "@/modules/reports";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Reports" };

/**
 * The report catalogue.
 *
 * Shows only what this caller may run. The filtering happens in the service,
 * derived from each report's declared permission — so a Worker is never offered
 * a card that would then refuse them, and adding a report cannot accidentally
 * expose it.
 */
export default async function ReportsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title text-foreground">Reports</h1>
        <p className="text-description text-foreground-muted">
          Operational reports across every module, exportable as CSV, Excel or PDF.
        </p>
      </header>

      <Suspense fallback={<CatalogueSkeleton />}>
        <Catalogue />
      </Suspense>
    </div>
  );
}

async function Catalogue() {
  const actor = await getCurrentUser();
  const reports = reportsService.catalogue(actor);

  return <ReportsCatalogue reports={reports} />;
}

/** 04_UI_GUIDELINES.md: skeletons, never spinners, matching the real layout. */
function CatalogueSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-32 w-full" />
      ))}
    </div>
  );
}
