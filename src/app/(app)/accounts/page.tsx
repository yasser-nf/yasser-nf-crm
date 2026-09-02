import type { Metadata } from "next";
import { Suspense } from "react";

import {
  AccountSelectionProvider,
  AccountsFilters,
  AccountsTable,
  BulkAccountsDialog,
  CreateAccountDialog,
  ExportAccountsMenu,
  accountsService,
  parseAccountFilter,
} from "@/modules/accounts";
import { ErrorState } from "@/shared/feedback/error-state";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = {
  title: "Accounts",
};

/**
 * Accounts list.
 *
 * 02_ARCHITECTURE.md: the app directory composes pages and holds no business
 * logic. Filtering, sorting and the profile tallies all belong to the service
 * and the repository.
 *
 * A Server Component, so the first paint carries real data. Reads go straight to
 * the service — Server Actions exist for mutations from the client, and routing a
 * server-side read through one would add a round trip for nothing.
 */

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseAccountFilter(await searchParams);

  return (
    <AccountSelectionProvider>
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <h1 className="text-page-title text-foreground">Accounts</h1>
            <p className="text-description text-foreground-muted">
              Every Netflix account and the state of its five profiles.
            </p>
          </div>

          {/* flex-wrap so three controls stack rather than overflow on a phone. */}
          <div className="flex flex-wrap items-center gap-2">
            <ExportAccountsMenu />
            <BulkAccountsDialog />
            <CreateAccountDialog />
          </div>
        </header>

        <Suspense fallback={<FiltersSkeleton />}>
          <AccountsFilters />
        </Suspense>

        <Suspense key={JSON.stringify(filter)} fallback={<TableSkeleton />}>
          <AccountsList filter={filter} />
        </Suspense>
      </div>
    </AccountSelectionProvider>
  );
}

async function AccountsList({ filter }: { filter: ReturnType<typeof parseAccountFilter> }) {
  const result = await accountsService.listAccounts(filter);

  if (!result.ok) {
    return <ErrorState error={result.error} title="Could not load accounts" />;
  }

  return (
    <AccountsTable
      items={result.value.items}
      total={result.value.total}
      limit={result.value.limit}
      offset={result.value.offset}
      sortBy={filter.sortBy}
      sortDirection={filter.sortDirection}
    />
  );
}

function FiltersSkeleton() {
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <Skeleton className="h-11 flex-1 sm:max-w-xs" />
      <Skeleton className="h-11 sm:w-56" />
    </div>
  );
}

/** 04_UI_GUIDELINES.md: skeletons, never spinners, matching the real layout. */
function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-11 w-full" />
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  );
}
