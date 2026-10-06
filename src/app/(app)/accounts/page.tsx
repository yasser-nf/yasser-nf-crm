import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ROUTES } from "@/config/constants";
import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";

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
import { suppliersService } from "@/modules/suppliers";
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
            {/*
              M03: this list is the OPERATIONAL accounts. An account with a
              blocking problem is excluded by the query itself and managed from
              Problems until it is resolved, when it returns here on its own.
            */}
            <p className="text-description text-foreground-muted">
              Accounts in working order, and the state of their five profiles. Accounts with a
              blocking problem are under{" "}
              <Link href={`${ROUTES.PROBLEMS}?status=blocking`} className="text-primary underline">
                Problems
              </Link>
              .
            </p>
          </div>

          {/* flex-wrap so three controls stack rather than overflow on a phone. */}
          <div className="flex flex-wrap items-center gap-2">
            <ExportAccountsMenu />
            <BulkAccountsDialog />
            <Suspense fallback={<Skeleton className="h-9 w-32" />}>
              <NewAccountButton />
            </Suspense>
          </div>
        </header>

        <Suspense fallback={<FiltersSkeleton />}>
          <FiltersRow />
        </Suspense>

        <Suspense key={JSON.stringify(filter)} fallback={<TableSkeleton />}>
          <AccountsList filter={filter} />
        </Suspense>
      </div>
    </AccountSelectionProvider>
  );
}

/**
 * The create dialog, with the suppliers an account may be attributed to.
 *
 * `listOptions` refuses a role without VIEW_SUPPLIERS, so the field simply is
 * not offered to one — and `createAccount` independently requires
 * MANAGE_SUPPLIERS before honouring a supplier, so a crafted request cannot
 * set one either.
 */
async function NewAccountButton() {
  const actor = await getCurrentUser();
  const options = await suppliersService.listOptions({ actor });

  return <CreateAccountDialog supplierOptions={options.ok ? options.value : []} />;
}

/**
 * The filter bar, with the supplier options it may offer. M10 §9.
 *
 * The options come from `suppliersService`, which refuses a role without
 * VIEW_SUPPLIERS — so a Worker without it gets an empty list and no supplier
 * select at all, rather than a control that returns nothing. A failed read
 * degrades the same way: the rest of the filters still work.
 */
async function FiltersRow() {
  const actor = await getCurrentUser();
  const options = await suppliersService.listOptions({ actor });

  return (
    <AccountsFilters
      suppliers={
        options.ok ? options.value.map((option) => ({ id: option.id, name: option.name })) : []
      }
    />
  );
}

async function AccountsList({ filter }: { filter: ReturnType<typeof parseAccountFilter> }) {
  const result = await accountsService.listAccounts(filter);

  if (!result.ok) {
    return <ErrorState error={result.error} title="Could not load accounts" />;
  }

  /* Only what to offer. Each bulk action's service checks the same permission. */
  const actor = await getCurrentUser();
  const canDelete = actor !== null && roleHasPermission(actor.role, PERMISSIONS.DELETE_ACCOUNTS);
  const canEditNotes = actor !== null && roleHasPermission(actor.role, PERMISSIONS.EDIT_ACCOUNTS);

  return (
    <AccountsTable
      items={result.value.items}
      total={result.value.total}
      limit={result.value.limit}
      offset={result.value.offset}
      sortBy={filter.sortBy}
      sortDirection={filter.sortDirection}
      canDelete={canDelete}
      canEditNotes={canEditNotes}
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
