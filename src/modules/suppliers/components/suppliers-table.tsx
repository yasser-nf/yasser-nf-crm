"use client";

import { Pencil, Truck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { ROUTES } from "@/config/constants";
import { EmptyState } from "@/shared/feedback/empty-state";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import type { SupplierListItem } from "../services/suppliers.service";
import { EditSupplierDialog } from "./supplier-dialogs";

/**
 * The supplier list (M09B).
 *
 * Two counts per row, both computed by PostgreSQL in the same query that read
 * the list: how many accounts came from this supplier, and how many of those
 * have a blocking problem right now. The second is the number that decides
 * whether a supplier is worth buying from again, so it is on the list rather
 * than one click inside it.
 *
 * A table on a wide screen and cards on a phone, as elsewhere in the CRM.
 */
export function SuppliersTable({
  items,
  total,
  limit,
  offset,
  filtered,
  canManage,
}: {
  readonly items: readonly SupplierListItem[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly filtered: boolean;
  readonly canManage: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [editing, setEditing] = useState<SupplierListItem | null>(null);

  function pageHref(nextOffset: number): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("offset", String(nextOffset));
    return `${pathname}?${params.toString()}`;
  }

  if (items.length === 0) {
    if (offset > 0 && total > 0) {
      return (
        <EmptyState
          icon={Truck}
          title="No suppliers on this page"
          description="The list has fewer pages than that."
          action={{ label: "Back to the first page", onClick: () => router.push(pageHref(0)) }}
        />
      );
    }

    return filtered ? (
      <EmptyState
        icon={Truck}
        title="No suppliers match"
        description="Try a shorter search, or include archived suppliers."
        action={{ label: "Clear search", onClick: () => router.push(pathname) }}
      />
    ) : (
      <EmptyState
        icon={Truck}
        title="No suppliers yet"
        description="Add the people and shops you buy accounts from, then mark an account as supplied to link it to one."
      />
    );
  }

  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(Math.ceil(total / limit), 1);

  return (
    <div className="flex flex-col gap-4">
      <div className="hidden overflow-x-auto rounded-lg border border-border lg:block">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-surface">
            <TableRow className="hover:bg-transparent">
              <TableHead>Supplier</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead className="text-right">Accounts</TableHead>
              <TableHead className="text-right">With problems</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((supplier) => (
              <TableRow key={supplier.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`${ROUTES.SUPPLIERS}/${supplier.id}`}
                      className="text-foreground hover:underline"
                    >
                      {supplier.name}
                    </Link>
                    {supplier.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
                  </div>
                </TableCell>
                <TableCell className="text-foreground-muted">{supplier.contact ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{supplier.accountCount}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {supplier.problemCount > 0 ? (
                    <span className="text-danger">{supplier.problemCount}</span>
                  ) : (
                    <span className="text-foreground-subtle">0</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {canManage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(supplier)}
                      aria-label={`Edit ${supplier.name}`}
                    >
                      <Pencil className="size-4" aria-hidden="true" />
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="flex flex-col gap-3 lg:hidden">
        {items.map((supplier) => (
          <li
            key={supplier.id}
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <Link
                href={`${ROUTES.SUPPLIERS}/${supplier.id}`}
                className="text-card-title text-foreground hover:underline"
              >
                {supplier.name}
              </Link>
              {supplier.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
            </div>

            {supplier.contact ? (
              <p className="text-caption text-foreground-muted">{supplier.contact}</p>
            ) : null}

            <p className="text-caption text-foreground-muted">
              <span className="text-foreground tabular-nums">{supplier.accountCount}</span> account
              {supplier.accountCount === 1 ? "" : "s"}
              {supplier.problemCount > 0 ? (
                <span className="text-danger"> · {supplier.problemCount} with problems</span>
              ) : null}
            </p>

            {canManage ? (
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setEditing(supplier)}>
                  Edit
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
        <p className="text-caption text-foreground-subtle">
          {total} supplier{total === 1 ? "" : "s"} · page {page} of {pageCount}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => router.push(pageHref(Math.max(offset - limit, 0)))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + limit >= total}
            onClick={() => router.push(pageHref(offset + limit))}
          >
            Next
          </Button>
        </div>
      </div>

      {editing ? (
        <EditSupplierDialog
          supplier={editing}
          open={editing !== null}
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}
