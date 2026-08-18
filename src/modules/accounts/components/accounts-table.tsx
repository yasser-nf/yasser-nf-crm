"use client";

import { motion } from "framer-motion";
import { ArrowDown, ArrowUp, ChevronsUpDown, Tv } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { ROUTES } from "@/config/constants";
import { DURATION, EASING } from "@/config/theme";
import type { AccountSortField } from "../repositories/accounts.repository";
import type { AccountListRow } from "../services/accounts.service";
import { Button } from "@/shared/ui/button";
import { EmptyState } from "@/shared/feedback/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import { cn } from "@/utils/cn";
import { CopyCredentials } from "./copy-credentials";
import { ProfileIndicators, ProfileIndicatorLegend } from "./profile-indicators";
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
  readonly items: readonly AccountListRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly sortBy: AccountSortField;
  readonly sortDirection: "asc" | "desc";
}

/**
 * Remaining account validity, in words.
 *
 * Open-ended is stated rather than rendered as a date, because an account with
 * no boundary is not the same as one expiring today and showing "—" invites the
 * reader to supply their own meaning. No arithmetic here: the number arrives
 * already computed by `accountRemainingDays`.
 */
function validityLabel(remainingDays: number | null, validUntil: string | null): string {
  if (remainingDays === null || validUntil === null) {
    return "Open-ended";
  }

  if (remainingDays < 0) {
    return `Expired ${Math.abs(remainingDays)}d ago`;
  }

  if (remainingDays === 0) {
    return "Expires today";
  }

  return `${remainingDays}d left`;
}

function validityTone(remainingDays: number | null): string {
  if (remainingDays === null) return "text-foreground-muted";
  if (remainingDays < 0) return "text-danger";
  if (remainingDays < 15) return "text-warning";
  return "text-foreground-muted";
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
      <ProfileIndicatorLegend />

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
              <TableHead className="text-caption text-foreground-muted">Profiles</TableHead>
              <TableHead className="text-caption text-foreground-muted">Validity</TableHead>
              <TableHead className="text-right text-caption text-foreground-muted">Copy</TableHead>
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

                {/* All five, on the same row. M13 §1. */}
                <TableCell>
                  <ProfileIndicators indicators={row.indicators} />
                </TableCell>

                <TableCell className={cn("text-caption", validityTone(row.remainingValidityDays))}>
                  <span className="whitespace-nowrap">
                    {validityLabel(row.remainingValidityDays, row.account.validUntil)}
                  </span>
                  <span className="block text-foreground-subtle">
                    {row.account.profileSlots} of 5 sellable
                  </span>
                </TableCell>

                <TableCell className="text-right">
                  <CopyCredentials
                    accountId={row.account.id}
                    email={row.account.email}
                    className="justify-end"
                  />
                </TableCell>
              </motion.tr>
            ))}
          </TableBody>
        </Table>
      </div>

      {/*
        Mobile — cards, per 04_UI_GUIDELINES.md.

        The card is no longer a single <Link>: it now contains copy buttons, and
        nesting interactive controls inside an anchor is invalid HTML and makes
        the whole card unusable with a keyboard. The email is the link instead.
      */}
      <div className="flex flex-col gap-3 lg:hidden">
        {items.map((row) => (
          <article
            key={row.account.id}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <Link
                href={`${ROUTES.ACCOUNTS}/${row.account.id}`}
                className="min-w-0 flex-1 truncate text-card-title text-foreground hover:text-primary"
              >
                {row.account.email}
              </Link>
              <AccountStatusBadge status={row.account.status} />
            </div>

            <ProfileIndicators indicators={row.indicators} />

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-foreground-muted">
              <span>
                Health{" "}
                <span className={healthTone(row.account.healthScore)}>
                  {row.account.healthScore}
                </span>
              </span>
              <span className={validityTone(row.remainingValidityDays)}>
                {validityLabel(row.remainingValidityDays, row.account.validUntil)}
              </span>
              <span>{row.account.profileSlots} of 5 sellable</span>
              <span>{row.account.country ?? "—"}</span>
              <span>{formatDate(row.account.createdAt)}</span>
            </div>

            <CopyCredentials
              accountId={row.account.id}
              email={row.account.email}
              variant="full"
              className="flex-wrap"
            />
          </article>
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
