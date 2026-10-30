import { ArrowLeft, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PAGINATION, ROUTES } from "@/config/constants";
import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import {
  SupplierAccountsTable,
  SupplierDangerActions,
  suppliersService,
} from "@/modules/suppliers";
import { ErrorState } from "@/shared/feedback/error-state";
import { Badge } from "@/shared/ui/badge";

export const metadata: Metadata = { title: "Supplier" };

/**
 * Supplier detail (M09B).
 *
 * One supplier, the accounts that came from them, and how many of those are
 * blocked right now. The accounts are paginated on the server: a supplier may
 * have provided hundreds, and the page must not grow with them.
 */
export default async function SupplierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  const read = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const offsetRaw = Number.parseInt(read("offset") ?? "0", 10);
  const actor = await getCurrentUser();

  /* The accounts table offers a reassignment dropdown, so both reads run here. */
  const [result, options] = await Promise.all([
    suppliersService.detail(
      id,
      {
        withProblemsOnly: read("problems") === "1",
        offset: Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0,
      },
      actor,
    ),
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

    if (result.error instanceof NotFoundError) {
      notFound();
    }

    return <ErrorState error={result.error} title="Could not load this supplier" />;
  }

  const supplier = result.value;
  const canManage = actor !== null && roleHasPermission(actor.role, PERMISSIONS.MANAGE_SUPPLIERS);

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={ROUTES.SUPPLIERS}
        className="inline-flex w-fit items-center gap-2 text-caption text-foreground-muted hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        All suppliers
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h1 className="text-page-title text-foreground">{supplier.name}</h1>
            {supplier.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
          </div>

          {supplier.contact ? (
            <p className="text-description text-foreground-muted">{supplier.contact}</p>
          ) : null}

          <p className="text-caption text-foreground-subtle">
            {supplier.accountCount} account{supplier.accountCount === 1 ? "" : "s"}
            {supplier.problemCount > 0 ? (
              <span className="text-danger">
                {" "}
                · {supplier.problemCount} with a blocking problem
              </span>
            ) : null}
          </p>
        </div>

        {canManage ? (
          <div className="flex items-center gap-2">
            <SupplierDangerActions supplier={supplier} />
          </div>
        ) : null}
      </header>

      {supplier.notes ? (
        <section className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
          <h2 className="text-card-title text-foreground">Notes</h2>
          <p className="text-description whitespace-pre-wrap text-foreground-muted">
            {supplier.notes}
          </p>
        </section>
      ) : null}

      <SupplierAccountsTable
        rows={supplier.accounts.items}
        total={supplier.accounts.total}
        limit={supplier.accounts.limit || PAGINATION.DEFAULT_PAGE_SIZE}
        offset={supplier.accounts.offset}
        suppliers={options.ok ? options.value : []}
        canManage={canManage}
      />
    </div>
  );
}
