"use client";

import { Building2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ROUTES } from "@/config/constants";
import { EmptyState } from "@/shared/feedback/empty-state";
import { Badge } from "@/shared/ui/badge";
import { Input } from "@/shared/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import type { SupplierListEntry } from "../services/suppliers.service";
import { EditSupplierDialog, SupplierActiveToggle } from "./supplier-dialogs";

/**
 * The supplier list. M10 §28 and §29.
 *
 * Table on desktop, cards on mobile — both rendering the same rows, so they
 * cannot disagree. 04_UI_GUIDELINES.md requires exactly that, and the accounts
 * list already works this way.
 *
 * Account figures and the profile figure are separate columns and are never
 * added together (M10 §13). Every number arrives computed by the server from
 * the shared predicates; nothing here counts anything.
 */

export function SupplierStatusBadge({ status }: { status: "active" | "inactive" }) {
  return (
    <Badge
      className={
        status === "active"
          ? "border-success/40 bg-success-subtle text-success"
          : "border-border bg-background-secondary text-foreground-muted"
      }
    >
      {status === "active" ? "Active" : "Inactive"}
    </Badge>
  );
}

/** Search and status filters. State lives in the URL, as every other list does. */
export function SuppliersFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const currentSearch = searchParams.get("search") ?? "";
  const currentStatus = searchParams.get("status") ?? "all";

  const [searchInput, setSearchInput] = useState(currentSearch);
  const [syncedSearch, setSyncedSearch] = useState(currentSearch);

  /* Keep the box in step when the URL changes from elsewhere. */
  if (currentSearch !== syncedSearch) {
    setSyncedSearch(currentSearch);
    setSearchInput(currentSearch);
  }

  /* Debounced: a keystroke per route change would queue out-of-order responses. */
  useEffect(() => {
    if (searchInput === currentSearch) {
      return;
    }

    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());

      if (searchInput.trim()) {
        params.set("search", searchInput.trim());
      } else {
        params.delete("search");
      }

      router.push(`${pathname}?${params.toString()}`);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchInput, currentSearch, pathname, router, searchParams]);

  function setStatus(value: string) {
    const params = new URLSearchParams(searchParams.toString());

    if (value === "all") {
      params.delete("status");
    } else {
      params.set("status", value);
    }

    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Input
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
        placeholder="Search supplier name"
        aria-label="Search suppliers"
        className="h-11 flex-1 sm:max-w-xs"
      />

      <Select value={currentStatus} onValueChange={setStatus}>
        <SelectTrigger className="h-11 sm:w-48" aria-label="Filter by status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All suppliers</SelectItem>
          <SelectItem value="active">Active only</SelectItem>
          <SelectItem value="inactive">Inactive only</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function SuppliersTable({
  items,
  canManage,
}: {
  readonly items: readonly SupplierListEntry[];
  /** Decided on the server from the viewer's role; the service enforces the same. */
  readonly canManage: boolean;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="No suppliers yet"
        description="Accounts you buy from an external supplier can be attributed to it. Accounts of your own need no supplier."
      />
    );
  }

  return (
    <>
      {/* Desktop */}
      <div className="hidden overflow-hidden rounded-lg border border-border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Supplier</TableHead>
              <TableHead className="text-right">Accounts</TableHead>
              <TableHead className="text-right">Problems</TableHead>
              <TableHead className="text-right">Available profiles</TableHead>
              <TableHead>Status</TableHead>
              {canManage ? <TableHead className="text-right">Actions</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((entry) => (
              <TableRow key={entry.supplier.id}>
                <TableCell>
                  <Link
                    href={`${ROUTES.SUPPLIERS}/${entry.supplier.id}`}
                    className="font-medium text-foreground hover:text-primary hover:underline"
                  >
                    {entry.supplier.name}
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {entry.metrics.totalAccounts}
                </TableCell>
                <TableCell
                  className={
                    entry.metrics.problemAccounts > 0
                      ? "text-right text-warning tabular-nums"
                      : "text-right text-foreground-subtle tabular-nums"
                  }
                >
                  {entry.metrics.problemAccounts}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {entry.metrics.availableProfiles}
                </TableCell>
                <TableCell>
                  <SupplierStatusBadge status={entry.status} />
                </TableCell>
                {canManage ? (
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <EditSupplierDialog
                        supplierId={entry.supplier.id}
                        name={entry.supplier.name}
                        notes={entry.supplier.notes}
                      />
                      <SupplierActiveToggle
                        supplierId={entry.supplier.id}
                        name={entry.supplier.name}
                        active={entry.status === "active"}
                        accountCount={entry.metrics.totalAccounts}
                      />
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile: the same rows as cards. No sideways scrolling. */}
      <ul className="flex flex-col gap-3 md:hidden">
        {items.map((entry) => (
          <li
            key={entry.supplier.id}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <Link
                href={`${ROUTES.SUPPLIERS}/${entry.supplier.id}`}
                className="text-card-title text-foreground hover:text-primary"
              >
                {entry.supplier.name}
              </Link>
              <SupplierStatusBadge status={entry.status} />
            </div>

            <dl className="grid grid-cols-3 gap-3 text-caption">
              <div className="flex flex-col">
                <dt className="text-foreground-subtle">Accounts</dt>
                <dd className="text-foreground tabular-nums">{entry.metrics.totalAccounts}</dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-foreground-subtle">Problems</dt>
                <dd
                  className={
                    entry.metrics.problemAccounts > 0
                      ? "text-warning tabular-nums"
                      : "text-foreground tabular-nums"
                  }
                >
                  {entry.metrics.problemAccounts}
                </dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-foreground-subtle">Profiles free</dt>
                <dd className="text-foreground tabular-nums">{entry.metrics.availableProfiles}</dd>
              </div>
            </dl>

            {canManage ? (
              <div className="flex items-center gap-1">
                <EditSupplierDialog
                  supplierId={entry.supplier.id}
                  name={entry.supplier.name}
                  notes={entry.supplier.notes}
                />
                <SupplierActiveToggle
                  supplierId={entry.supplier.id}
                  name={entry.supplier.name}
                  active={entry.status === "active"}
                  accountCount={entry.metrics.totalAccounts}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
