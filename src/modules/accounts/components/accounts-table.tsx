"use client";

import { motion } from "framer-motion";
import { ArrowDown, ArrowUp, ChevronsUpDown, Tv } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { ROUTES } from "@/config/constants";
import { DURATION, EASING } from "@/config/theme";
import type { AccountWithCounts, AccountSortField } from "../repositories/accounts.repository";
import { Button } from "@/shared/ui/button";
import { EmptyState } from "@/shared/feedback/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import { cn } from "@/utils/cn";
import { AccountStatusBadge } from "./status-badge";

/**
 * Accounts list.
 *
 * 04_UI_GUIDELINES.md requires tables on desktop and cards on mobile, with a
 * sticky header, sorting, pagination, an empty state and no horizontal scroll.
 * Both renderings read the same data, so they cannot disagree.
 *
 * Sort and page state live in the URL rather than in component state. That makes
 * a filtered view shareable and survivable across a refresh, and it means the
 * server component re-runs the query rather than the client re-sorting a page it
 * only partially holds.
 */

interface AccountsTableProps {
  readonly items: readonly AccountWithCounts[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly sortBy: AccountSortField;
  readonly sortDirection: "asc" | "desc";
}

const COLUMNS: readonly { field: AccountSortField; label: string; className?: string }[] = [
  { field: "email", label: "Email" },
  { field: "status", label: "Status" },
  { field: "healthScore", label: "Health" },
  { field: "country", label: "Country" },
  { field: "createdAt", label: "Created" },
];

function formatDate(value: Date | string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Health score colour follows the semantic scale, not a gradient. */
function healthTone(score: number): string {
  if (score >= 80) return "text-success";
  if (score >= 50) return "text-warning";
  return "text-danger";
}

export function AccountsTable({
  items,
  total,
  limit,
  offset,
  sortBy,
  sortDirection,
}: AccountsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function buildHref(changes: Record<string, string>): string {
    const params = new URLSearchParams(searchParams.toString());

    for (const [key, value] of Object.entries(changes)) {
      params.set(key, value);
    }

    return `${pathname}?${params.toString()}`;
  }

  function toggleSort(field: AccountSortField) {
    const nextDirection = sortBy === field && sortDirection === "desc" ? "asc" : "desc";
    /* Any sort change returns to page one — page 4 of a new ordering is meaningless. */
    router.push(buildHref({ sortBy: field, sortDirection: nextDirection, offset: "0" }));
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Tv}
        title="No accounts yet"
        description="Create your first Netflix account. Five profiles are added automatically."
      />
    );
  }

  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(Math.ceil(total / limit), 1);

  return (
    <div className="flex flex-col gap-4">
      {/* Desktop */}
      <div className="hidden overflow-x-auto rounded-lg border border-border lg:block">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-surface">
            <TableRow className="hover:bg-transparent">
              {COLUMNS.map((column) => {
                const isActive = sortBy === column.field;

                return (
                  <TableHead
                    key={column.field}
                    className={column.className}
                    /*
                     * aria-sort belongs on the columnheader, not the button
                     * inside it. A button has no sortable semantics, so screen
                     * readers ignore the attribute there.
                     */
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
              <TableHead className="text-right text-caption text-foreground-muted">
                Available
              </TableHead>
              <TableHead className="text-right text-caption text-foreground-muted">Sold</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {items.map((row, index) => (
              <motion.tr
                key={row.account.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{
                  duration: DURATION.fast,
                  ease: EASING.standard,
                  /* Staggered, but capped so a full page never feels slow. */
                  delay: Math.min(index * 0.015, 0.15),
                }}
                className="border-b border-border transition-colors last:border-0 hover:bg-surface-raised"
              >
                <TableCell className="font-medium">
                  <Link
                    href={`${ROUTES.ACCOUNTS}/${row.account.id}`}
                    className="text-foreground hover:text-primary"
                  >
                    {row.account.email}
                  </Link>
                </TableCell>
                <TableCell>
                  <AccountStatusBadge status={row.account.status} />
                </TableCell>
                <TableCell className={cn("font-medium", healthTone(row.account.healthScore))}>
                  {row.account.healthScore}
                </TableCell>
                <TableCell className="text-foreground-muted">
                  {row.account.country ?? "—"}
                </TableCell>
                <TableCell className="text-foreground-muted">
                  {formatDate(row.account.createdAt)}
                </TableCell>
                <TableCell className="text-right font-medium text-success">
                  {row.availableProfiles}
                </TableCell>
                <TableCell className="text-right font-medium text-accent-purple">
                  {row.soldProfiles}
                </TableCell>
              </motion.tr>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile — cards, per 04_UI_GUIDELINES.md */}
      <div className="flex flex-col gap-3 lg:hidden">
        {items.map((row) => (
          <Link
            key={row.account.id}
            href={`${ROUTES.ACCOUNTS}/${row.account.id}`}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-card-title text-foreground">
                {row.account.email}
              </span>
              <AccountStatusBadge status={row.account.status} />
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-foreground-muted">
              <span>
                Health{" "}
                <span className={healthTone(row.account.healthScore)}>
                  {row.account.healthScore}
                </span>
              </span>
              <span>
                Available <span className="text-success">{row.availableProfiles}</span>
              </span>
              <span>
                Sold <span className="text-accent-purple">{row.soldProfiles}</span>
              </span>
              <span>{row.account.country ?? "—"}</span>
              <span>{formatDate(row.account.createdAt)}</span>
            </div>
          </Link>
        ))}
      </div>

      <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
        <p className="text-caption text-foreground-subtle">
          {total} account{total === 1 ? "" : "s"} · page {page} of {pageCount}
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
