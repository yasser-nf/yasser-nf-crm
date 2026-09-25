"use client";

import { ExternalLink, FilterX, ScrollText } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { EmptyState } from "@/shared/feedback/empty-state";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import { cn } from "@/utils/cn";
import type { LogEntry } from "../services/log-view";

/**
 * The audit log, one page at a time (M06).
 *
 * Everything shown comes from `LogEntry` — built on the server from the row,
 * with sensitive keys, ciphertext and free text already hidden. There is no
 * raw snapshot in this component to leak, and the detail dialog reads the
 * same entry: no second request, no second API.
 */

const ACTION_TONES: Record<string, string> = {
  create: "bg-success-subtle text-success",
  update: "bg-primary-subtle text-primary",
  delete: "bg-danger-subtle text-danger",
  archive: "bg-neutral-subtle text-foreground-muted",
  restore: "bg-warning-subtle text-warning",
};

function ActionBadge({ entry }: { entry: LogEntry }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-caption font-medium whitespace-nowrap",
        ACTION_TONES[entry.action] ?? "bg-surface-raised text-foreground-muted",
      )}
    >
      {entry.actionLabel}
    </span>
  );
}

function actorText(entry: LogEntry): string {
  return entry.actor.name ?? entry.actor.email ?? "System";
}

interface Props {
  readonly items: readonly LogEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /** Whether any filter or search is applied — decides which empty state is true. */
  readonly filtered: boolean;
}

export function LogsTable({ items, total, limit, offset, filtered }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState<LogEntry | null>(null);

  function pageHref(nextOffset: number): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("offset", String(nextOffset));
    return `${pathname}?${params.toString()}`;
  }

  if (items.length === 0) {
    if (offset > 0 && total > 0) {
      return (
        <EmptyState
          icon={ScrollText}
          title="No entries on this page"
          description="The log has fewer pages than that."
          action={{ label: "Back to the first page", onClick: () => router.push(pageHref(0)) }}
        />
      );
    }

    return filtered ? (
      <EmptyState
        icon={FilterX}
        title="No entries match these filters"
        description="Nothing in the audit log matches. Try a wider date range or fewer filters."
        action={{ label: "Clear filters", onClick: () => router.push(pathname) }}
      />
    ) : (
      <EmptyState
        icon={ScrollText}
        title="No audit entries yet"
        description="Actions such as creating accounts or resolving problems are recorded here."
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
              {["Time (UTC)", "Person", "Action", "Entity", "Summary", ""].map((label) => (
                <TableHead key={label} className="text-caption text-foreground-muted">
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="font-mono text-caption whitespace-nowrap text-foreground-muted">
                  <time dateTime={entry.createdAt}>
                    {entry.createdAtDisplay.replace(" UTC", "")}
                  </time>
                </TableCell>
                <TableCell className="max-w-48">
                  <div className="truncate text-description text-foreground">
                    {actorText(entry)}
                  </div>
                  {entry.actor.name && entry.actor.email ? (
                    <div className="truncate text-caption text-foreground-subtle">
                      {entry.actor.email}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <ActionBadge entry={entry} />
                </TableCell>
                <TableCell className="max-w-56">
                  <div className="text-description text-foreground">{entry.entityLabel}</div>
                  <div className="truncate text-caption text-foreground-subtle">
                    {entry.subject ?? entry.entityId.slice(0, 8)}
                  </div>
                </TableCell>
                <TableCell className="max-w-md">
                  <span className="line-clamp-2 text-description text-foreground">
                    {entry.summary}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => setOpen(entry)}>
                    Details
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Phones and tablets: one card per entry, no horizontal scrolling. */}
      <ul className="flex flex-col gap-2 lg:hidden">
        {items.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => setOpen(entry)}
              className="flex w-full flex-col gap-1.5 rounded-lg border border-border bg-surface p-3 text-left"
            >
              <div className="flex items-center justify-between gap-2">
                <ActionBadge entry={entry} />
                <time
                  dateTime={entry.createdAt}
                  className="font-mono text-caption text-foreground-subtle"
                >
                  {entry.createdAtDisplay}
                </time>
              </div>
              <span className="text-description break-words text-foreground">{entry.summary}</span>
              <span className="text-caption break-words text-foreground-muted">
                {entry.entityLabel}
                {entry.subject ? ` · ${entry.subject}` : ""} · {actorText(entry)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
        <p className="text-caption text-foreground-subtle">
          {total} entr{total === 1 ? "y" : "ies"} · page {page} of {pageCount}
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

      <LogDetailDialog entry={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-caption text-foreground-subtle">{label}</dt>
      <dd className="text-description break-words text-foreground">{children}</dd>
    </div>
  );
}

export function LogDetailDialog({
  entry,
  onClose,
}: {
  entry: LogEntry | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={entry !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        {entry ? (
          <>
            <DialogHeader>
              <DialogTitle>{entry.summary}</DialogTitle>
              <DialogDescription>
                Passwords, PINs, tokens and typed notes are never shown here.
              </DialogDescription>
            </DialogHeader>

            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Time">
                <time dateTime={entry.createdAt}>{entry.createdAtDisplay}</time>
              </Field>
              <Field label="Person">
                {actorText(entry)}
                {entry.actor.name && entry.actor.email ? (
                  <span className="block text-caption text-foreground-subtle">
                    {entry.actor.email}
                  </span>
                ) : null}
              </Field>
              <Field label="Action">
                {entry.actionLabel}
                {entry.eventLabel ? ` · ${entry.eventLabel}` : ""}
              </Field>
              <Field label="Entity">
                {entry.entityLabel}
                {entry.subject ? ` · ${entry.subject}` : ""}
                <span className="block font-mono text-caption text-foreground-subtle">
                  {entry.entityId}
                </span>
                {entry.href ? (
                  <Link
                    href={entry.href}
                    className="mt-1 inline-flex items-center gap-1 text-caption text-primary hover:underline"
                  >
                    Open {entry.entityLabel.toLowerCase()}
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </Link>
                ) : null}
              </Field>
            </dl>

            {entry.changes.length > 0 ? (
              <section className="flex flex-col gap-2">
                <h3 className="text-card-title text-foreground">Changes</h3>
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-left text-caption">
                    <thead className="bg-surface-raised text-foreground-muted">
                      <tr>
                        <th className="px-3 py-2 font-medium">Field</th>
                        <th className="px-3 py-2 font-medium">Before</th>
                        <th className="px-3 py-2 font-medium">After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.changes.map((change) => (
                        <tr key={change.field} className="border-t border-border align-top">
                          <td className="px-3 py-2 text-foreground">{change.label}</td>
                          <td className="px-3 py-2 break-words text-foreground-muted">
                            {change.before ?? "—"}
                          </td>
                          <td className="px-3 py-2 break-words text-foreground">
                            {change.after ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}

            {entry.details.length > 0 ? (
              <section className="flex flex-col gap-2">
                <h3 className="text-card-title text-foreground">Details</h3>
                <dl className="grid gap-3 sm:grid-cols-2">
                  {entry.details.map((detail) => (
                    <Field key={detail.label} label={detail.label}>
                      {detail.value}
                    </Field>
                  ))}
                </dl>
              </section>
            ) : null}

            {entry.source.ipAddress || entry.source.userAgent ? (
              <section className="flex flex-col gap-2">
                <h3 className="text-card-title text-foreground">Source</h3>
                <dl className="grid gap-3 sm:grid-cols-2">
                  {entry.source.ipAddress ? (
                    <Field label="IP address">{entry.source.ipAddress}</Field>
                  ) : null}
                  {entry.source.userAgent ? (
                    <Field label="Browser">{entry.source.userAgent}</Field>
                  ) : null}
                </dl>
              </section>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
