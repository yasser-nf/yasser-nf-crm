import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { PAGINATION } from "@/config/constants";
import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/errors";
import {
  CreateSupplierDialog,
  SupplierMetricsStrip,
  SuppliersFilters,
  SuppliersTable,
  UnassignedAccounts,
  suppliersService,
  type SupplierFilter,
} from "@/modules/suppliers";
import { ErrorState } from "@/shared/feedback/error-state";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Suppliers" };

/**
 * Suppliers list (M09B).
 *
 * Super Admin only: the service refuses `view_suppliers` to a Worker, and this
 * page renders the refusal rather than an empty list — a supplier's contact
 * details and purchase history are not operational data a Worker needs.
 */

function parseSearchParams(params: Record<string, string | string[] | undefined>): SupplierFilter {
  const read = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const offsetRaw = Number.parseInt(read("offset") ?? "0", 10);

  return {
    search: read("search"),
    includeArchived: read("archived") === "1",
    offset: Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0,
    limit: PAGINATION.DEFAULT_PAGE_SIZE,
  };
}

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseSearchParams(await searchParams);
  const actor = await getCurrentUser();
  const canManage = actor !== null && roleHasPermission(actor.role, PERMISSIONS.MANAGE_SUPPLIERS);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-page-title text-foreground">Suppliers</h1>
          <p className="text-description text-foreground-muted">
            Who you buy accounts from, how many came from each, and how many of those are giving
            trouble.
          </p>
        </div>

        {canManage ? <CreateSupplierDialog /> : null}
      </header>

      <Suspense fallback={<Skeleton className="h-11 w-full max-w-md" />}>
        <SuppliersFilters />
      </Suspense>

      <Suspense key={JSON.stringify(filter)} fallback={<ListSkeleton />}>
        <SuppliersList filter={filter} canManage={canManage} />
      </Suspense>
    </div>
  );
}

async function SuppliersList({
  filter,
  canManage,
}: {
  filter: SupplierFilter;
  canManage: boolean;
}) {
  const actor = await getCurrentUser();

  /*
   * The overview and the picker list in parallel. The triage rows each carry a
   * supplier dropdown, and reading its options here means the browser fetches
   * nothing — a Worker is refused both, and sees the refusal below.
   */
  const [result, options] = await Promise.all([
    suppliersService.overview(filter, actor),
    suppliersService.options(actor),
  ]);

  if (!result.ok) {
    if (result.error instanceof ForbiddenError) {
      return (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-16 text-center">
          <ShieldAlert className="size-6 text-foreground-subtle" aria-hidden="true" />
          <h2 className="text-section-title text-foreground">Not available to your role</h2>
          <p className="max-w-sm text-description text-foreground-muted">
            Suppliers are restricted to Super Admins.
          </p>
        </div>
      );
    }

    return <ErrorState error={result.error} title="Could not load suppliers" />;
  }

  const { metrics, suppliers, unassigned } = result.value;

  return (
    <div className="flex flex-col gap-6">
      <SupplierMetricsStrip metrics={metrics} />

      <UnassignedAccounts
        accounts={unassigned}
        suppliers={options.ok ? options.value : []}
        canManage={canManage}
      />

      <SuppliersTable
        items={suppliers.items}
        total={suppliers.total}
        limit={suppliers.limit}
        offset={suppliers.offset}
        filtered={Boolean(filter.search) || Boolean(filter.includeArchived)}
        canManage={canManage}
      />
    </div>
  );
}

/** 04_UI_GUIDELINES.md: skeletons, never spinners, matching the real layout. */
function ListSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    </div>
  );
}
