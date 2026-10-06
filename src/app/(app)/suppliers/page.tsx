import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import {
  CreateSupplierDialog,
  SuppliersFilters,
  SuppliersTable,
  suppliersService,
} from "@/modules/suppliers";
import { ErrorState } from "@/shared/feedback/error-state";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Suppliers" };

/**
 * Suppliers. M10 §28.
 *
 * Route composition only. `suppliersService` decides who may see the list
 * (VIEW_SUPPLIERS — Super Admin and Worker) and who may change one
 * (MANAGE_SUPPLIERS — Super Admin); this page renders that answer, including a
 * refusal.
 *
 * Never prerendered: every figure is counted from live accounts and profiles,
 * and a cached supplier page would advertise stock that has moved.
 */
export const dynamic = "force-dynamic";

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const actor = await getCurrentUser();

  const canView = actor !== null && roleHasPermission(actor.role, PERMISSIONS.VIEW_SUPPLIERS);
  const canManage = actor !== null && roleHasPermission(actor.role, PERMISSIONS.MANAGE_SUPPLIERS);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-page-title text-foreground">Suppliers</h1>
          <p className="text-description text-foreground-muted">
            Where your accounts came from. An account with no supplier is your own.
          </p>
        </div>

        {canManage ? <CreateSupplierDialog /> : null}
      </header>

      {canView ? (
        <>
          <Suspense fallback={<Skeleton className="h-11 w-full sm:max-w-md" />}>
            <SuppliersFilters />
          </Suspense>

          <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton />}>
            <SupplierList params={params} canManage={canManage} />
          </Suspense>
        </>
      ) : (
        <section className="flex items-start gap-3 rounded-lg border border-border bg-surface p-5">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <h2 className="text-card-title text-foreground">Not available to your role</h2>
            <p className="text-caption text-foreground-muted">
              Viewing suppliers requires the supplier permission. Ask a Super Admin if you need it.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}

async function SupplierList({
  params,
  canManage,
}: {
  params: Record<string, string | string[] | undefined>;
  canManage: boolean;
}) {
  const actor = await getCurrentUser();

  /*
   * The query string reaches the service, which validates it. A page does not
   * sanitise input on a service's behalf — `supplierFilterSchema` is the one
   * place that decides what a status filter may be.
   */
  const search = typeof params["search"] === "string" ? params["search"] : undefined;
  const status = typeof params["status"] === "string" ? params["status"] : "all";

  const result = await suppliersService.listSuppliers({ search, status }, { actor });

  if (!result.ok) {
    return <ErrorState error={result.error} title="Could not load suppliers" />;
  }

  return <SuppliersTable items={result.value} canManage={canManage} />;
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-11 w-full" />
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  );
}
