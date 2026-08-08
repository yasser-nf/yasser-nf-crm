import type { Metadata } from "next";
import { Suspense } from "react";

import { PAGINATION } from "@/config/constants";
import {
  AccountsFilters,
  AccountsTable,
  CreateAccountDialog,
  accountsService,
  type AccountSortField,
} from "@/modules/accounts";
import { ErrorState } from "@/shared/feedback/error-state";
import { Skeleton } from "@/shared/ui/skeleton";
import type { AccountRow } from "@/lib/drizzle/schema";

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

const SORT_FIELDS: readonly AccountSortField[] = [
  "email",
  "status",
  "healthScore",
  "country",
  "createdAt",
];

const ACCOUNT_STATUSES: readonly AccountRow["status"][] = [
  "healthy",
  "payment_problem",
  "incorrect_password",
  "invalid_email",
  "something_went_wrong",
  "archived",
  "deleted",
];

/**
 * Query strings are user input.
 *
 * Every value is validated against a known set before it reaches the service. An
 * unrecognised sort column or status silently falls back to the default rather
 * than being passed down.
 */
function parseSearchParams(params: Record<string, string | string[] | undefined>) {
  const read = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const sortByRaw = read("sortBy");
  const statusRaw = read("status");
  const offsetRaw = Number.parseInt(read("offset") ?? "0", 10);

  const sortBy = SORT_FIELDS.find((field) => field === sortByRaw) ?? "createdAt";
  const status = ACCOUNT_STATUSES.find((value) => value === statusRaw);

  return {
    search: read("search"),
    status,
    sortBy,
    sortDirection: read("sortDirection") === "asc" ? ("asc" as const) : ("desc" as const),
    offset: Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0,
    limit: PAGINATION.DEFAULT_PAGE_SIZE,
  };
}

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseSearchParams(await searchParams);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-page-title text-foreground">Accounts</h1>
          <p className="text-description text-foreground-muted">
            Every Netflix account and the state of its five profiles.
          </p>
        </div>

        <CreateAccountDialog />
      </header>

      <Suspense fallback={<FiltersSkeleton />}>
        <AccountsFilters />
      </Suspense>

      <Suspense key={JSON.stringify(filter)} fallback={<TableSkeleton />}>
        <AccountsList filter={filter} />
      </Suspense>
    </div>
  );
}

async function AccountsList({ filter }: { filter: ReturnType<typeof parseSearchParams> }) {
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
