"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, ChevronsUpDown, Tv } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useEffect, useState } from "react";

import { ROUTES } from "@/config/constants";
import { DURATION, EASING } from "@/config/theme";
import type { AccountSortField } from "../repositories/accounts.repository";
import type { AccountListRow } from "../services/accounts.service";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { EmptyState } from "@/shared/feedback/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import { cn } from "@/utils/cn";
import {
  EMPTY_SELECTION,
  actionableIds,
  allSelected,
  partitionByProblem,
  resultSetKey,
  someSelected,
  toggleAll,
  toggleSelected,
  type Selection,
} from "../services/account-selection";
import { validityLabel } from "../services/account-presentation";
import { useAccountSelection } from "./account-selection-context";
import { AccountNoteCell } from "./account-note-cell";
import { AccountProfilesPanel } from "./account-profiles-panel";
import { BulkSelectionBar } from "./bulk-selection-bar";
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
  /** Decided on the server from the viewer's role; the services enforce the same. */
  readonly canDelete?: boolean;
  readonly canEditNotes?: boolean;
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

export function AccountsTable({
  items,
  total,
  limit,
  offset,
  sortBy,
  sortDirection,
  canDelete = false,
  canEditNotes = false,
}: AccountsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  /* Honours the OS setting: the panel still opens, it just does not travel. */
  const reduceMotion = useReducedMotion();

  const visibleIds = items.map((row) => row.account.id);

  /*
   * Selection is cleared whenever the displayed set changes.
   *
   * The page already remounts this component on a filter change, via the
   * Suspense key, so today this is belt and braces. It is deliberate belt and
   * braces: if that key is ever removed, selection would silently survive a
   * search and the next Delete would act on rows the operator can no longer
   * see. Too dangerous to leave resting on a detail of a parent.
   *
   * Assigning state during render is the documented way to reset on a prop
   * change, and is the pattern accounts-filters.tsx already uses.
   */
  const filterKey = resultSetKey({
    search: searchParams.get("search") ?? undefined,
    status: searchParams.get("status") ?? undefined,
    sortBy,
    sortDirection,
    offset,
  });

  /*
   * The selection lives here, with the rules that govern it. Adjusting state
   * during render is only legal for a component own state, and the reset
   * below is exactly that pattern.
   */
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [syncedKey, setSyncedKey] = useState(filterKey);

  if (filterKey !== syncedKey) {
    setSyncedKey(filterKey);
    setSelection(EMPTY_SELECTION);
  }

  /*
   * Published after commit, never during render, so the Export menu in the page
   * header sees the same ticks without this component writing to a parent while
   * it is rendering.
   */
  const { publishSelection } = useAccountSelection();

  useEffect(() => {
    publishSelection(selection);
  }, [selection, publishSelection]);

  /* Never the raw Set: only ids that are both selected and on screen. */
  const selectedIds = actionableIds(selection, visibleIds);

  /*
   * The two problem actions are opposites, so the selection is split by what
   * each one can act on rather than offered wholesale. A page is routinely a
   * mix of healthy and problem accounts, and an operator who ticks all of them
   * should not have to untick half before either action is safe.
   */
  const { withProblem, withoutProblem } = partitionByProblem(
    items.map((row) => ({ id: row.account.id, hasActiveProblem: row.hasActiveProblem })),
    selection,
  );
  const everySelected = allSelected(selection, visibleIds);
  const partiallySelected = someSelected(selection, visibleIds);

  /*
   * Which rows are open. A Set rather than a single id, because closing one
   * account to read another is busywork when the point is comparing them.
   * Purely local: it touches no query string and no database.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  function toggleExpanded(accountId: string) {
    setExpanded((current) => {
      const next = new Set(current);

      if (!next.delete(accountId)) {
        next.add(accountId);
      }

      return next;
    });
  }

  function clearSelection() {
    setSelection(EMPTY_SELECTION);
  }

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
        title="No operational accounts"
        description="Nothing matches here. Accounts with a blocking problem are listed under Problems."
      />
    );
  }

  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(Math.ceil(total / limit), 1);

  return (
    <div className="flex flex-col gap-4">
      <BulkSelectionBar
        accounts={items
          .filter((row) => selectedIds.includes(row.account.id))
          .map((row) => ({
            id: row.account.id,
            email: row.account.email,
            notes: row.account.notes,
          }))}
        withProblem={withProblem}
        withoutProblem={withoutProblem}
        canDelete={canDelete}
        canEditNotes={canEditNotes}
        onClear={clearSelection}
      />

      <ProfileIndicatorLegend />

      {/* Desktop */}
      <div className="hidden overflow-x-auto rounded-lg border border-border lg:block">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-surface">
            <TableRow className="hover:bg-transparent">
              {/* The disclosure column. Header is blank; the buttons are labelled. */}
              <TableHead className="w-10" />
              {/* Before Email, so a row reads: pick this one, then what it is. */}
              <TableHead className="w-10">
                <Checkbox
                  /*
                   * Indeterminate when only some rows are ticked. A two-state
                   * box would have to claim all or nothing, and either claim is
                   * wrong while a subset is selected.
                   */
                  checked={everySelected ? true : partiallySelected ? "indeterminate" : false}
                  onCheckedChange={() => setSelection(toggleAll(selection, visibleIds))}
                  aria-label={
                    everySelected ? "Clear selection" : "Select all accounts on this page"
                  }
                />
              </TableHead>
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
              <TableHead className="text-caption text-foreground-muted">Notes</TableHead>
              <TableHead className="text-right text-caption text-foreground-muted">Copy</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {items.map((row, index) => {
              const isExpanded = expanded.has(row.account.id);
              const panelId = `account-profiles-${row.account.id}`;

              return (
                <Fragment key={row.account.id}>
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
                    data-selected={selection.has(row.account.id) || undefined}
                    className={cn(
                      "border-b border-border transition-colors hover:bg-surface-raised",
                      selection.has(row.account.id) && "bg-primary/5 hover:bg-primary/10",
                      /* The panel supplies the separator when the row is open. */
                      isExpanded && "border-b-0",
                    )}
                  >
                    <TableCell>
                      {/*
                    Its own cell, before the checkbox, so the disclosure never
                    competes with selection for the same click. The button is the
                    only thing that toggles: the row itself is not clickable, so
                    Copy, the note pencil and the email link cannot expand a row
                    by accident and need no stopPropagation.
                  */}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => toggleExpanded(row.account.id)}
                        aria-expanded={isExpanded}
                        aria-controls={panelId}
                        aria-label={`${isExpanded ? "Collapse" : "Expand"} profiles for ${row.account.email}`}
                        className="text-foreground-subtle hover:text-foreground"
                      >
                        {isExpanded ? (
                          <ChevronUp aria-hidden="true" />
                        ) : (
                          <ChevronDown aria-hidden="true" />
                        )}
                      </Button>
                    </TableCell>

                    <TableCell>
                      <Checkbox
                        checked={selection.has(row.account.id)}
                        onCheckedChange={() =>
                          setSelection(toggleSelected(selection, row.account.id))
                        }
                        aria-label={`Select ${row.account.email}`}
                      />
                    </TableCell>

                    <TableCell className="font-medium">
                      <Link
                        href={`${ROUTES.ACCOUNTS}/${row.account.id}`}
                        className="text-foreground hover:text-primary"
                      >
                        {row.account.email}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <AccountStatusBadge
                        status={row.account.status}
                        hasActiveProblem={row.hasActiveProblem}
                        activeProblemTypes={row.activeProblemTypes}
                      />
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

                    <TableCell
                      className={cn("text-caption", validityTone(row.remainingValidityDays))}
                    >
                      <span className="whitespace-nowrap">
                        {validityLabel(row.remainingValidityDays, row.account.validUntil)}
                      </span>
                      <span className="block text-foreground-subtle">
                        {row.account.profileSlots} of 5 sellable
                      </span>
                    </TableCell>

                    <TableCell>
                      <AccountNoteCell
                        accountId={row.account.id}
                        accountEmail={row.account.email}
                        note={row.account.notes}
                      />
                    </TableCell>

                    <TableCell className="text-right">
                      <CopyCredentials
                        accountId={row.account.id}
                        email={row.account.email}
                        className="justify-end"
                      />
                    </TableCell>
                  </motion.tr>

                  <AnimatePresence initial={false}>
                    {isExpanded ? (
                      <motion.tr
                        key="panel"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{
                          duration: reduceMotion ? 0 : DURATION.fast,
                          ease: EASING.standard,
                        }}
                        className="border-b border-border"
                      >
                        <TableCell colSpan={COLUMNS.length + 6} className="p-0">
                          {/*
                            Height is animated on an inner div rather than on the
                            row: a <tr> cannot be given overflow, so collapsing it
                            directly leaves the content spilling over the row below.
                          */}
                          <motion.div
                            initial={{ height: 0 }}
                            animate={{ height: "auto" }}
                            exit={{ height: 0 }}
                            transition={{
                              duration: reduceMotion ? 0 : DURATION.fast,
                              ease: EASING.standard,
                            }}
                            className="overflow-hidden"
                          >
                            <div className="px-3 pb-3">
                              <AccountProfilesPanel
                                id={panelId}
                                accountId={row.account.id}
                                accountEmail={row.account.email}
                                profiles={row.profiles}
                              />
                            </div>
                          </motion.div>
                        </TableCell>
                      </motion.tr>
                    ) : null}
                  </AnimatePresence>
                </Fragment>
              );
            })}
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
            data-selected={selection.has(row.account.id) || undefined}
            className={cn(
              "flex flex-col gap-3 rounded-lg border bg-surface p-4 transition-colors",
              selection.has(row.account.id) ? "border-primary/40 bg-primary/5" : "border-border",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              {/*
                Same position as the desktop column — first, before the email,
                and grown to the 44x44 minimum 04_UI_GUIDELINES.md asks for.

                The area is expanded on the button itself, through a pseudo
                element, rather than by wrapping it in a padded <label>. A
                <button> is not a labelable control, so a label forwards
                nothing to it: the padding would hit-test as the label and do
                nothing at all. That is worse than a small target, because it
                looks like a large one — verified by hit-testing the padding,
                which resolved to LABEL and left the box untouched.

                A pseudo element belongs to the button, so every pixel of it is
                the button. The offsets borrow the card's 16px padding on the
                left and exactly the 12px gap on the right, which reaches 44px
                without overlapping the email link and stealing its taps.
              */}
              <Checkbox
                checked={selection.has(row.account.id)}
                onCheckedChange={() => setSelection(toggleSelected(selection, row.account.id))}
                aria-label={`Select ${row.account.email}`}
                className="relative mt-0.5 before:absolute before:-inset-y-3.5 before:-right-3 before:-left-4 before:content-['']"
              />

              <Link
                href={`${ROUTES.ACCOUNTS}/${row.account.id}`}
                className="min-w-0 flex-1 truncate text-card-title text-foreground hover:text-primary"
              >
                {row.account.email}
              </Link>
              <AccountStatusBadge
                status={row.account.status}
                hasActiveProblem={row.hasActiveProblem}
                activeProblemTypes={row.activeProblemTypes}
              />
            </div>

            <ProfileIndicators indicators={row.indicators} />

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-foreground-muted">
              <span className={validityTone(row.remainingValidityDays)}>
                {validityLabel(row.remainingValidityDays, row.account.validUntil)}
              </span>
              <span>{row.account.profileSlots} of 5 sellable</span>
              <span>{row.account.country ?? "—"}</span>
              <span>{formatDate(row.account.createdAt)}</span>
            </div>

            {/*
              The desktop table is hidden below lg, so this is where a phone
              sees and edits the note. Rendered inside the card rather than as a
              column, which is what keeps the narrow layout free of sideways
              scrolling.
            */}
            <AccountNoteCell
              accountId={row.account.id}
              accountEmail={row.account.email}
              note={row.account.notes}
              className="min-w-0"
            />

            <CopyCredentials
              accountId={row.account.id}
              email={row.account.email}
              variant="full"
              className="flex-wrap"
            />

            {/*
              The desktop table is hidden below lg, so this is the disclosure a
              phone actually uses. Full width and min-h-11, which is the 44px
              touch target 04_UI_GUIDELINES.md requires — reached by sizing the
              control itself rather than haloing a small one.
            */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => toggleExpanded(row.account.id)}
              aria-expanded={expanded.has(row.account.id)}
              aria-controls={`account-profiles-card-${row.account.id}`}
              aria-label={`${expanded.has(row.account.id) ? "Collapse" : "Expand"} profiles for ${row.account.email}`}
              className="min-h-11 w-full gap-2"
            >
              {expanded.has(row.account.id) ? (
                <>
                  <ChevronUp className="size-4" aria-hidden="true" />
                  Hide profiles
                </>
              ) : (
                <>
                  <ChevronDown className="size-4" aria-hidden="true" />
                  Show profiles
                </>
              )}
            </Button>

            <AnimatePresence initial={false}>
              {expanded.has(row.account.id) ? (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{
                    duration: reduceMotion ? 0 : DURATION.fast,
                    ease: EASING.standard,
                  }}
                  className="overflow-hidden"
                >
                  <AccountProfilesPanel
                    id={`account-profiles-card-${row.account.id}`}
                    accountId={row.account.id}
                    accountEmail={row.account.email}
                    profiles={row.profiles}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
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
