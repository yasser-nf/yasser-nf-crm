import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/errors";
import {
  JobsFilters,
  JobsTable,
  hasActiveJobFilters,
  jobsService,
  parseJobsFilter,
  type JobsFilterInput,
} from "@/modules/jobs";
import { ErrorState } from "@/shared/feedback/error-state";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Jobs" };

/**
 * Jobs (M08 jobs): the durable background queue.
 *
 * Route composition only. `jobsService` decides who may see it (Super Admins,
 * `view_jobs`) and who may cancel (`manage_jobs`), and turns every row into a
 * safe item; this page renders that answer — including a refusal.
 */
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseJobsFilter(await searchParams);
  const actor = await getCurrentUser();
  const permitted = actor !== null && roleHasPermission(actor.role, PERMISSIONS.VIEW_JOBS);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title text-foreground">Jobs</h1>
        <p className="text-description text-foreground-muted">
          Background work, claimed and run by workers. Each job runs its business operation at most
          once; a job whose worker goes silent is recovered automatically.
        </p>
      </header>

      {permitted ? (
        <Suspense fallback={<Skeleton className="h-24 w-full" />}>
          <FiltersRow />
        </Suspense>
      ) : null}

      <Suspense key={JSON.stringify(filter)} fallback={<TableSkeleton />}>
        <JobsList filter={filter} />
      </Suspense>
    </div>
  );
}

async function FiltersRow() {
  const actor = await getCurrentUser();
  const types = await jobsService.types(actor);

  return <JobsFilters types={types.ok ? types.value : []} />;
}

async function JobsList({ filter }: { filter: JobsFilterInput }) {
  const actor = await getCurrentUser();
  const result = await jobsService.list(filter, actor);

  if (!result.ok) {
    if (result.error instanceof ForbiddenError) {
      return (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-16 text-center">
          <ShieldAlert className="size-6 text-foreground-subtle" aria-hidden="true" />
          <h2 className="text-section-title text-foreground">Not available to your role</h2>
          <p className="max-w-sm text-description text-foreground-muted">
            Jobs are restricted to Super Admins.
          </p>
        </div>
      );
    }

    /* ERROR IS NOT EMPTY: a failed query never renders as "no jobs". */
    return <ErrorState error={result.error} title="Could not load jobs" />;
  }

  return (
    <JobsTable
      items={result.value.items}
      total={result.value.total}
      limit={result.value.limit}
      offset={result.value.offset}
      filtered={hasActiveJobFilters(filter)}
      canManage={actor !== null && roleHasPermission(actor.role, PERMISSIONS.MANAGE_JOBS)}
    />
  );
}

function TableSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading jobs" className="flex flex-col gap-3">
      <Skeleton className="h-11 w-full" />
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  );
}
