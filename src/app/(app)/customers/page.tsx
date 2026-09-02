import type { Metadata } from "next";
import { Suspense } from "react";

import {
  CustomersFilters,
  CustomersTable,
  ExportCustomersMenu,
  customersService,
  parseCustomerFilter,
} from "@/modules/customers";
import { ErrorState } from "@/shared/feedback/error-state";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Customers" };

/**
 * Customers list.
 *
 * A Server Component, so the first paint carries real data and the search runs
 * in Postgres rather than filtering a page the client only partly holds.
 */

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseCustomerFilter(await searchParams);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-page-title text-foreground">Customers</h1>
          <p className="text-description text-foreground-muted">
            Everyone who has bought a subscription, and what they currently hold.
          </p>
        </div>

        <ExportCustomersMenu />
      </header>

      <Suspense fallback={<Skeleton className="h-11 w-full max-w-md" />}>
        <CustomersFilters />
      </Suspense>

      <Suspense key={JSON.stringify(filter)} fallback={<TableSkeleton />}>
        <CustomersList filter={filter} />
      </Suspense>
    </div>
  );
}

async function CustomersList({ filter }: { filter: ReturnType<typeof parseCustomerFilter> }) {
  const result = await customersService.list(filter);

  if (!result.ok) {
    return <ErrorState error={result.error} title="Could not load customers" />;
  }

  return (
    <CustomersTable
      items={result.value.items}
      total={result.value.total}
      limit={result.value.limit}
      offset={result.value.offset}
      sortBy={filter.sortBy}
      sortDirection={filter.sortDirection}
    />
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
