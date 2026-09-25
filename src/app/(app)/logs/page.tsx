import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/errors";
import {
  LogsFilters,
  LogsTable,
  hasActiveFilters,
  logsService,
  parseLogsFilter,
  type LogsFilterInput,
} from "@/modules/audit";
import { usersService } from "@/modules/users";
import { ErrorState } from "@/shared/feedback/error-state";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Logs" };

/**
 * Logs (M06): the audit trail.
 *
 * Route composition only. `logsService` decides who may read it (Super Admins,
 * `view_logs`) and turns every row into a safe entry; this page renders that
 * answer — including a refusal — and decides nothing itself.
 */
export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseLogsFilter(await searchParams);
  const actor = await getCurrentUser();
  const permitted = actor !== null && roleHasPermission(actor.role, PERMISSIONS.VIEW_LOGS);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title text-foreground">Logs</h1>
        <p className="text-description text-foreground-muted">
          Who did what, to which record, and when. Entries are recorded after an action succeeds and
          are never edited or deleted.
        </p>
      </header>

      {/* Filters are offered only to someone who may read what they filter. */}
      {permitted ? (
        <Suspense fallback={<Skeleton className="h-24 w-full" />}>
          <FiltersRow />
        </Suspense>
      ) : null}

      <Suspense key={JSON.stringify(filter)} fallback={<TableSkeleton />}>
        <LogsList filter={filter} />
      </Suspense>
    </div>
  );
}

/** The people filter, through the users module's own API — never a join from here. */
async function FiltersRow() {
  const actor = await getCurrentUser();
  const result = await usersService.list({ limit: 100, offset: 0 }, actor);

  const actors = result.ok
    ? result.value.items.map((entry) => ({ id: entry.user.id, name: entry.user.name }))
    : [];

  return <LogsFilters actors={actors} />;
}

async function LogsList({ filter }: { filter: LogsFilterInput }) {
  const actor = await getCurrentUser();
  const result = await logsService.list(filter, actor);

  if (!result.ok) {
    /* A refusal is not a failure: a Worker is told why, not sent chasing a bug. */
    if (result.error instanceof ForbiddenError) {
      return (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-16 text-center">
          <ShieldAlert className="size-6 text-foreground-subtle" aria-hidden="true" />
          <h2 className="text-section-title text-foreground">Not available to your role</h2>
          <p className="max-w-sm text-description text-foreground-muted">
            The audit log is restricted to Super Admins.
          </p>
        </div>
      );
    }

    /* ERROR IS NOT EMPTY: a query that failed never renders as "no entries". */
    return <ErrorState error={result.error} title="Could not load the audit log" />;
  }

  return (
    <LogsTable
      items={result.value.items}
      total={result.value.total}
      limit={result.value.limit}
      offset={result.value.offset}
      filtered={hasActiveFilters(filter)}
    />
  );
}

/** 04_UI_GUIDELINES.md: skeletons, never spinners, matching the real layout. */
function TableSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the audit log" className="flex flex-col gap-3">
      <Skeleton className="h-11 w-full" />
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  );
}
