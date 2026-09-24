"use client";

import { motion } from "framer-motion";
import { Search, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ROUTES } from "@/config/constants";
import { DURATION, EASING } from "@/config/theme";
import { EmptyState } from "@/shared/feedback/empty-state";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import {
  EMPTY_SELECTION,
  actionableIds,
  allSelected,
  someSelected,
  toggleAll,
  toggleSelected,
  type Selection,
} from "@/utils/selection";
import type { ProblemListEntry } from "../repositories/problems.repository";
import { ProblemsBulkBar, type Assignee } from "./problems-bulk-bar";
import { isBlocking } from "../services/problem-lifecycle";
import {
  PROBLEM_TYPE_LABELS,
  ProblemStatusBadge,
  formatDateTime,
  problemAge,
} from "./problem-shared";

/**
 * Problems list.
 *
 * Table on desktop, cards on mobile. Filter, sort and search state lives in the
 * URL so a view is shareable and survives a refresh — the same pattern as the
 * accounts, customers and users lists.
 *
 * M03: each row answers the workflow's questions — which account, which
 * problem, is it still blocking — and links to both. Severity is gone from the
 * screen (filter, column and sort); the column is kept in the database.
 */

/** Whether a problem stops its account selling. `isBlocking`, never restated. */
function BlockingMark({ status }: { status: ProblemListEntry["problem"]["status"] }) {
  return isBlocking(status) ? (
    <span className="inline-flex items-center gap-1.5 text-caption font-medium text-danger">
      <span className="size-1.5 shrink-0 rounded-full bg-danger" aria-hidden="true" />
      Blocking
    </span>
  ) : (
    <span className="text-caption text-foreground-subtle">Not blocking</span>
  );
}

interface Props {
  readonly items: readonly ProblemListEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /** People a problem may be assigned to, for the bulk Assign. */
  readonly assignees?: readonly Assignee[];
  /** Offered to a Super Admin; the services decide what is permitted. */
  readonly canAssign?: boolean;
  readonly canDelete?: boolean;
}

export function ProblemsFilters({ workers }: { workers: readonly { id: string; name: string }[] }) {
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

  /* Debounced: one request per keystroke lets responses arrive out of order. */
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

  function setParam(key: string, next: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === null) params.delete(key);
    else params.set(key, next);
    params.set("offset", "0");
    router.push(`${pathname}?${params.toString()}`);
  }

  const status = searchParams.get("status");
  const assignedTo = searchParams.get("assignedTo");
  const issueType = searchParams.get("type");

  const hasFilters = current !== "" || status !== null || assignedTo !== null || issueType !== null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground-subtle"
            aria-hidden="true"
          />
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Problem ID, account email, customer, worker"
            aria-label="Search problems"
            className="h-11 pl-9"
          />
        </div>

        <select
          value={status ?? ""}
          onChange={(event) => setParam("status", event.target.value || null)}
          aria-label="Filter by status"
          className="h-11 rounded-md border border-border bg-surface px-3 text-description text-foreground"
        >
          <option value="">All statuses</option>
          {/* Every problem still stopping its account selling: open, in progress, waiting. */}
          <option value="blocking">Blocking now</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="waiting">Waiting</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={issueType ?? ""}
          onChange={(event) => setParam("type", event.target.value || null)}
          aria-label="Filter by problem type"
          className="h-10 rounded-md border border-border bg-surface px-3 text-caption text-foreground"
        >
          <option value="">All types</option>
          {Object.entries(PROBLEM_TYPE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>

        <select
          value={assignedTo ?? ""}
          onChange={(event) => setParam("assignedTo", event.target.value || null)}
          aria-label="Filter by assigned worker"
          className="h-10 rounded-md border border-border bg-surface px-3 text-caption text-foreground"
        >
          <option value="">Anyone</option>
          {workers.map((worker) => (
            <option key={worker.id} value={worker.id}>
              {worker.name}
            </option>
          ))}
        </select>

        <input
          type="date"
          value={searchParams.get("from") ?? ""}
          onChange={(event) => setParam("from", event.target.value || null)}
          aria-label="Created after"
          className="h-10 rounded-md border border-border bg-surface px-3 text-caption text-foreground"
        />

        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(pathname)}
            className="gap-1.5"
          >
            <X className="size-4" aria-hidden="true" />
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ProblemsTable({
  items,
  total,
  limit,
  offset,
  assignees = [],
  canAssign = false,
  canDelete = false,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const now = new Date();

  /*
   * Selection, by problem id — never by account, which can carry several.
   *
   * Cleared whenever the query string changes: page, search, status, type,
   * assignee, date and sort all live there, so any of them starts a new,
   * empty selection. Resetting state during render is the documented pattern
   * and the one the accounts table uses.
   */
  const resultKey = searchParams.toString();
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [syncedKey, setSyncedKey] = useState(resultKey);

  if (resultKey !== syncedKey) {
    setSyncedKey(resultKey);
    setSelection(EMPTY_SELECTION);
  }

  const visibleIds = items.map((entry) => entry.problem.id);
  /* Only ids both selected and on screen, in display order. */
  const selectedIds = actionableIds(selection, visibleIds);
  const selectedProblems = items
    .filter((entry) => selectedIds.includes(entry.problem.id))
    .map((entry) => ({ id: entry.problem.id, status: entry.problem.status }));
  const clearSelection = () => setSelection(EMPTY_SELECTION);

  function pageHref(nextOffset: number): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("offset", String(nextOffset));
    return `${pathname}?${params.toString()}`;
  }

  function sortBy(field: string) {
    const params = new URLSearchParams(searchParams.toString());
    const currentField = params.get("sortBy");
    const currentDirection = params.get("dir") ?? "desc";

    params.set("sortBy", field);
    params.set("dir", currentField === field && currentDirection === "desc" ? "asc" : "desc");
    router.push(`${pathname}?${params.toString()}`);
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={TriangleAlert}
        title="No problems match"
        description="Nothing is currently blocking an account for these filters."
      />
    );
  }

  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(Math.ceil(total / limit), 1);

  return (
    <div className="flex flex-col gap-4">
      <ProblemsBulkBar
        problems={selectedProblems}
        assignees={assignees}
        canAssign={canAssign}
        canDelete={canDelete}
        onClear={clearSelection}
      />

      <div className="hidden overflow-x-auto rounded-lg border border-border lg:block">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-surface">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10">
                <Checkbox
                  checked={
                    allSelected(selection, visibleIds)
                      ? true
                      : someSelected(selection, visibleIds)
                        ? "indeterminate"
                        : false
                  }
                  onCheckedChange={() => setSelection(toggleAll(selection, visibleIds))}
                  aria-label="Select all problems on this page"
                />
              </TableHead>
              <TableHead className="text-caption text-foreground-muted">Account</TableHead>
              <TableHead className="text-caption text-foreground-muted">Problem</TableHead>
              <TableHead className="text-caption text-foreground-muted">Blocking</TableHead>
              <TableHead className="text-caption text-foreground-muted">
                <button
                  type="button"
                  onClick={() => sortBy("status")}
                  className="hover:text-foreground"
                >
                  Status
                </button>
              </TableHead>
              <TableHead className="text-caption text-foreground-muted">Assigned</TableHead>
              <TableHead className="text-caption text-foreground-muted">Reported by</TableHead>
              <TableHead className="text-caption text-foreground-muted">
                <button
                  type="button"
                  onClick={() => sortBy("createdAt")}
                  className="hover:text-foreground"
                >
                  Created
                </button>
              </TableHead>
              <TableHead className="text-caption text-foreground-muted">Age</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {items.map((entry, index) => (
              <motion.tr
                key={entry.problem.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{
                  duration: DURATION.fast,
                  ease: EASING.standard,
                  delay: Math.min(index * 0.015, 0.15),
                }}
                className="border-b border-border transition-colors last:border-0 hover:bg-surface-raised"
              >
                <TableCell>
                  <Checkbox
                    checked={selection.has(entry.problem.id)}
                    onCheckedChange={() =>
                      setSelection(toggleSelected(selection, entry.problem.id))
                    }
                    aria-label={`Select ${PROBLEM_TYPE_LABELS[entry.problem.issueType] ?? entry.problem.issueType} on ${entry.accountEmail}`}
                  />
                </TableCell>
                <TableCell className="text-caption">
                  <Link
                    href={`${ROUTES.ACCOUNTS}/${entry.problem.accountId}`}
                    className="text-foreground-muted hover:text-primary"
                  >
                    {entry.accountEmail}
                  </Link>
                </TableCell>
                <TableCell className="font-medium">
                  <Link
                    href={`${ROUTES.PROBLEMS}/${entry.problem.id}`}
                    className="text-foreground hover:text-primary"
                  >
                    {PROBLEM_TYPE_LABELS[entry.problem.issueType] ?? entry.problem.issueType}
                  </Link>
                </TableCell>
                <TableCell>
                  {/* A blocking problem stops all five profiles. ADR-010 D2. */}
                  <BlockingMark status={entry.problem.status} />
                </TableCell>
                <TableCell>
                  <ProblemStatusBadge status={entry.problem.status} />
                </TableCell>
                <TableCell className="text-caption text-foreground-muted">
                  {entry.assignedToName ?? "Unassigned"}
                </TableCell>
                <TableCell className="text-caption text-foreground-muted">
                  {entry.reportedByName ?? "—"}
                </TableCell>
                <TableCell className="text-caption text-foreground-muted">
                  {formatDateTime(entry.problem.createdAt)}
                </TableCell>
                <TableCell className="text-caption text-foreground-muted">
                  {problemAge(entry.problem.createdAt, entry.problem.resolvedAt, now)}
                </TableCell>
              </motion.tr>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile — cards, per 04_UI_GUIDELINES.md */}
      <div className="flex flex-col gap-3 lg:hidden">
        {items.map((entry) => (
          /*
            The checkbox sits beside the card link, not inside it, so ticking
            a card never opens the problem.
          */
          <div key={entry.problem.id} className="flex items-start gap-3">
            <Checkbox
              className="mt-4"
              checked={selection.has(entry.problem.id)}
              onCheckedChange={() => setSelection(toggleSelected(selection, entry.problem.id))}
              aria-label={`Select ${PROBLEM_TYPE_LABELS[entry.problem.issueType] ?? entry.problem.issueType} on ${entry.accountEmail}`}
            />
            <Link
              href={`${ROUTES.PROBLEMS}/${entry.problem.id}`}
              className="flex min-w-0 flex-1 flex-col gap-3 rounded-lg border border-border bg-surface p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="truncate text-card-title text-foreground">
                  {PROBLEM_TYPE_LABELS[entry.problem.issueType] ?? entry.problem.issueType}
                </span>
                <ProblemStatusBadge status={entry.problem.status} />
              </div>
              <span className="truncate text-caption text-foreground-subtle">
                {entry.accountEmail}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <BlockingMark status={entry.problem.status} />
                <span className="text-caption text-foreground-subtle">
                  {entry.assignedToName ?? "Unassigned"} ·{" "}
                  {problemAge(entry.problem.createdAt, entry.problem.resolvedAt, now)}
                </span>
              </div>
            </Link>
          </div>
        ))}
      </div>

      <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
        <p className="text-caption text-foreground-subtle">
          {total} problem{total === 1 ? "" : "s"} · page {page} of {pageCount}
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
    </div>
  );
}
