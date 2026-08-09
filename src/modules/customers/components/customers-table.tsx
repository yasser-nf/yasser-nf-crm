"use client";

import { motion } from "framer-motion";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ROUTES } from "@/config/constants";
import { DURATION, EASING } from "@/config/theme";
import { formatPhoneForDisplay } from "@/lib/phone";
import { EmptyState } from "@/shared/feedback/empty-state";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import { cn } from "@/utils/cn";
import type { CustomerSortField, CustomerWithStats } from "../repositories/customers.repository";
import { deriveCustomerStatus } from "../services/customer-status";
import { CopyButton, CustomerStatusBadge, WhatsappButton } from "./customer-shared";

/**
 * Customers list.
 *
 * Table on desktop, cards on mobile, per 04_UI_GUIDELINES.md. Both read the
 * same rows so they cannot disagree.
 *
 * Filter and sort state live in the URL: a filtered view is then shareable and
 * survives a refresh, and the server re-runs the query rather than the client
 * re-sorting a page it only partly holds.
 */

interface Props {
  readonly items: readonly CustomerWithStats[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly sortBy: CustomerSortField;
  readonly sortDirection: "asc" | "desc";
}

const COLUMNS: readonly { field: CustomerSortField; label: string }[] = [
  { field: "phoneNormalized", label: "Phone" },
  { field: "lastPurchaseAt", label: "Last purchase" },
  { field: "createdAt", label: "Created" },
];

function formatDate(value: Date | string | null): string {
  return value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
}

export function CustomersFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const current = searchParams.get("search") ?? "";
  const [value, setValue] = useState(current);
  const [synced, setSynced] = useState(current);

  if (current !== synced) {
    setSynced(current);
    setValue(current);
  }

  /* Debounced: a keystroke per request would let responses arrive out of order. */
  useEffect(() => {
    if (value === current) {
      return;
    }

    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (value.trim()) params.set("search", value.trim());
      else params.delete("search");
      params.set("offset", "0");
      router.push(`${pathname}?${params.toString()}`);
    }, 300);

    return () => clearTimeout(timer);
  }, [value, current, pathname, router, searchParams]);

  function toggle(key: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (params.get(key) === "1") params.delete(key);
    else params.set(key, "1");
    params.set("offset", "0");
    router.push(`${pathname}?${params.toString()}`);
  }

  const activeOnly = searchParams.get("active") === "1";
  const blockedOnly = searchParams.get("blocked") === "1";
  const hasFilters = current !== "" || activeOnly || blockedOnly;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative flex-1 sm:max-w-md">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground-subtle"
          aria-hidden="true"
        />
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Phone, Netflix email, PIN, notes"
          aria-label="Search customers"
          className="h-11 pl-9"
        />
      </div>

      <Button variant={activeOnly ? "default" : "outline"} onClick={() => toggle("active")}>
        Active only
      </Button>
      <Button variant={blockedOnly ? "default" : "outline"} onClick={() => toggle("blocked")}>
        Blocked
      </Button>

      {hasFilters ? (
        <Button variant="ghost" onClick={() => router.push(pathname)} className="gap-1.5">
          <X className="size-4" aria-hidden="true" />
          Clear
        </Button>
      ) : null}
    </div>
  );
}

export function CustomersTable({ items, total, limit, offset, sortBy, sortDirection }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function buildHref(changes: Record<string, string>): string {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, val] of Object.entries(changes)) params.set(key, val);
    return `${pathname}?${params.toString()}`;
  }

  function toggleSort(field: CustomerSortField) {
    const next = sortBy === field && sortDirection === "desc" ? "asc" : "desc";
    router.push(buildHref({ sortBy: field, sortDirection: next, offset: "0" }));
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No customers yet"
        description="Customers are created automatically the first time you prepare a subscription for them."
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
              {COLUMNS.map((column) => {
                const isActive = sortBy === column.field;
                return (
                  <TableHead
                    key={column.field}
                    aria-sort={
                      isActive ? (sortDirection === "asc" ? "ascending" : "descending") : "none"
                    }
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column.field)}
                      className={cn(
                        "inline-flex items-center gap-1.5 text-caption font-medium transition-colors",
                        isActive
                          ? "text-foreground"
                          : "text-foreground-muted hover:text-foreground",
                      )}
                    >
                      {column.label}
                      {isActive ? (
                        sortDirection === "asc" ? (
                          <ArrowUp className="size-3" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="size-3" aria-hidden="true" />
                        )
                      ) : (
                        <ChevronsUpDown className="size-3 opacity-50" aria-hidden="true" />
                      )}
                    </button>
                  </TableHead>
                );
              })}
              <TableHead className="text-caption text-foreground-muted">Status</TableHead>
              <TableHead className="text-right text-caption text-foreground-muted">
                Active
              </TableHead>
              <TableHead className="text-right text-caption text-foreground-muted">
                Expired
              </TableHead>
              <TableHead className="text-caption text-foreground-muted">Notes</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>

          <TableBody>
            {items.map((row, index) => (
              <motion.tr
                key={row.customer.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{
                  duration: DURATION.fast,
                  ease: EASING.standard,
                  delay: Math.min(index * 0.015, 0.15),
                }}
                className="border-b border-border transition-colors last:border-0 hover:bg-surface-raised"
              >
                <TableCell className="font-medium">
                  <Link
                    href={`${ROUTES.CUSTOMERS}/${row.customer.id}`}
                    className="font-mono text-foreground hover:text-primary"
                  >
                    {formatPhoneForDisplay(row.customer.phoneNormalized)}
                  </Link>
                </TableCell>
                <TableCell className="text-foreground-muted">
                  {formatDate(row.customer.lastPurchaseAt)}
                </TableCell>
                <TableCell className="text-foreground-muted">
                  {formatDate(row.customer.createdAt)}
                </TableCell>
                <TableCell>
                  <CustomerStatusBadge
                    status={deriveCustomerStatus(
                      row.customer,
                      /* Only the tally is known here; one active profile is enough. */
                      Array.from({ length: row.activeProfiles }, () => ({
                        status: "sold",
                        expirationDate: null,
                      })),
                      new Date(),
                    )}
                  />
                </TableCell>
                <TableCell className="text-right font-medium text-success">
                  {row.activeProfiles}
                </TableCell>
                <TableCell className="text-right font-medium text-foreground-muted">
                  {row.expiredProfiles}
                </TableCell>
                <TableCell className="max-w-48 truncate text-caption text-foreground-subtle">
                  {row.customer.notes ?? "—"}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1.5">
                    <CopyButton
                      value={row.customer.phoneNormalized}
                      label="Copy phone"
                      size="icon-sm"
                    />
                    <WhatsappButton url={row.customer.whatsappUrl} variant="ghost" />
                  </div>
                </TableCell>
              </motion.tr>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile — cards, per 04_UI_GUIDELINES.md */}
      <div className="flex flex-col gap-3 lg:hidden">
        {items.map((row) => (
          <div
            key={row.customer.id}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <Link
                href={`${ROUTES.CUSTOMERS}/${row.customer.id}`}
                className="font-mono text-card-title text-foreground"
              >
                {formatPhoneForDisplay(row.customer.phoneNormalized)}
              </Link>
              <CustomerStatusBadge
                status={deriveCustomerStatus(
                  row.customer,
                  Array.from({ length: row.activeProfiles }, () => ({
                    status: "sold",
                    expirationDate: null,
                  })),
                  new Date(),
                )}
              />
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-foreground-muted">
              <span>
                Active <span className="text-success">{row.activeProfiles}</span>
              </span>
              <span>Expired {row.expiredProfiles}</span>
              <span>Last {formatDate(row.customer.lastPurchaseAt)}</span>
            </div>

            <div className="flex gap-2">
              <CopyButton value={row.customer.phoneNormalized} label="Copy phone" />
              <WhatsappButton url={row.customer.whatsappUrl} />
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
        <p className="text-caption text-foreground-subtle">
          {total} customer{total === 1 ? "" : "s"} · page {page} of {pageCount}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => router.push(buildHref({ offset: String(Math.max(offset - limit, 0)) }))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + limit >= total}
            onClick={() => router.push(buildHref({ offset: String(offset + limit) }))}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
