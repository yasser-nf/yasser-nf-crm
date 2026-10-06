import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ROUTES } from "@/config/constants";
import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import { AccountsTable, accountsService, parseAccountFilter } from "@/modules/accounts";
import { Metric, MetricGrid, Widget } from "@/modules/dashboard";
import {
  EditSupplierDialog,
  SupplierActiveToggle,
  SupplierStatusBadge,
  suppliersService,
} from "@/modules/suppliers";
import { ErrorState } from "@/shared/feedback/error-state";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Supplier" };

/**
 * Supplier detail. M10 §11.
 *
 * Three parts: the supplier, its figures, and its accounts — rendered with the
 * EXISTING `AccountsTable`, so a supplier's accounts look and behave exactly
 * like the Accounts page's. M10 §11 asks for that specifically.
 *
 * ACCOUNT FIGURES AND THE PROFILE FIGURE ARE SEPARATE (M10 §13). "Total
 * accounts" and "available profiles" are different units and are never added.
 *
 * Every figure is one aggregate query away, composed from the shared predicates
 * — no per-account loop (M10 §25).
 */
export const dynamic = "force-dynamic";

export default async function SupplierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const actor = await getCurrentUser();

  if (actor === null || !roleHasPermission(actor.role, PERMISSIONS.VIEW_SUPPLIERS)) {
    /*
     * A 404 rather than a refusal page. A role that may not see suppliers has
     * no business learning which supplier ids exist — M10 §26, and the same
     * reasoning the service's read check follows.
     */
    notFound();
  }

  const detail = await suppliersService.getSupplier(id, { actor });

  if (!detail.ok) {
    if (detail.error instanceof NotFoundError) {
      notFound();
    }

    return <ErrorState error={detail.error} title="Could not load this supplier" />;
  }

  const { supplier, status, metrics } = detail.value;
  const canManage = roleHasPermission(actor.role, PERMISSIONS.MANAGE_SUPPLIERS);
  const filter = parseAccountFilter(await searchParams);

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={ROUTES.SUPPLIERS}
        className="inline-flex w-fit items-center gap-1.5 text-caption text-foreground-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        All suppliers
      </Link>

      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-page-title text-foreground">{supplier.name}</h1>
            <SupplierStatusBadge status={status} />
          </div>

          {supplier.notes ? (
            <p className="max-w-prose text-description text-foreground-muted">{supplier.notes}</p>
          ) : null}

          {status === "inactive" ? (
            <p className="text-caption text-foreground-subtle">
              Inactive. Its accounts keep their supplier; no new account can be assigned to it.
            </p>
          ) : null}
        </div>

        {canManage ? (
          <div className="flex items-center gap-1">
            <EditSupplierDialog
              supplierId={supplier.id}
              name={supplier.name}
              notes={supplier.notes}
            />
            <SupplierActiveToggle
              supplierId={supplier.id}
              name={supplier.name}
              active={status === "active"}
              accountCount={metrics.totalAccounts}
            />
          </div>
        ) : null}
      </header>

      {/* M10 §12 and §13: account figures, then the profile figure, labelled. */}
      <Widget title="Accounts" description="Counted by the same rule as every account badge">
        <MetricGrid>
          <Metric label="Total accounts" value={metrics.totalAccounts} />
          <Metric label="Healthy" value={metrics.healthyAccounts} tone="success" />
          <Metric
            label="With problems"
            value={metrics.problemAccounts}
            tone={metrics.problemAccounts > 0 ? "warning" : "default"}
          />
          <Metric
            label="Expired"
            value={metrics.expiredAccounts}
            tone={metrics.expiredAccounts > 0 ? "danger" : "default"}
          />
          <Metric label="Archived" value={metrics.archivedAccounts} tone="muted" />
        </MetricGrid>
      </Widget>

      <Widget
        title="Profiles"
        description="A profile figure, not an account one — allocatable right now"
      >
        <MetricGrid>
          <Metric label="Available profiles" value={metrics.availableProfiles} />
        </MetricGrid>
      </Widget>

      <section className="flex flex-col gap-4">
        <h2 className="text-section-title text-foreground">Accounts from this supplier</h2>

        <Suspense key={JSON.stringify(filter)} fallback={<TableSkeleton />}>
          <SupplierAccounts supplierId={id} filter={filter} />
        </Suspense>
      </section>
    </div>
  );
}

/**
 * This supplier's accounts, through the Accounts page's own service and table.
 *
 * The supplier narrowing is applied in the WHERE clause by the repository, so
 * the page, the total and every later page are counted over the same set
 * (M10 §9).
 */
async function SupplierAccounts({
  supplierId,
  filter,
}: {
  supplierId: string;
  filter: ReturnType<typeof parseAccountFilter>;
}) {
  const result = await accountsService.listAccounts({ ...filter, supplierId });

  if (!result.ok) {
    return <ErrorState error={result.error} title="Could not load these accounts" />;
  }

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

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-11 w-full" />
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  );
}
