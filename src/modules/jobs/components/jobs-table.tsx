"use client";

import { useMutation } from "@tanstack/react-query";
import { FilterX, ListChecks } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

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
import { cancelJobAction } from "../actions/jobs.actions";
import type { JobDisplayState } from "../services/job-states";
import { JOB_STATE_LABELS, type JobListItem } from "../services/job-view";

/**
 * The jobs list (M08 jobs). Renders `JobListItem`s only — no payload, no
 * result, no claim token ever reaches this component.
 */

const STATE_TONES: Record<JobDisplayState, string> = {
  queued: "bg-neutral-subtle text-foreground-muted",
  retrying: "bg-warning-subtle text-warning",
  running: "bg-primary-subtle text-primary",
  stale: "bg-danger-subtle text-danger",
  succeeded: "bg-success-subtle text-success",
  failed: "bg-danger-subtle text-danger",
  cancelled: "bg-neutral-subtle text-foreground-muted",
};

function StateBadge({ job }: { job: JobListItem }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span
        className={cn(
          "inline-flex items-center rounded-md px-2 py-0.5 text-caption font-medium whitespace-nowrap",
          STATE_TONES[job.state],
        )}
      >
        {JOB_STATE_LABELS[job.state]}
      </span>
      {job.recoveredAt ? (
        <span className="rounded-md bg-warning-subtle px-1.5 py-0.5 text-caption text-warning">
          Recovered
        </span>
      ) : null}
    </span>
  );
}

function utc(value: string | null): string {
  return value ? `${value.slice(0, 19).replace("T", " ")} UTC` : "—";
}

interface Props {
  readonly items: readonly JobListItem[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly filtered: boolean;
  readonly canManage: boolean;
}

export function JobsTable({ items, total, limit, offset, filtered, canManage }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState<JobListItem | null>(null);

  function pageHref(nextOffset: number): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("offset", String(nextOffset));
    return `${pathname}?${params.toString()}`;
  }

  if (items.length === 0) {
    if (offset > 0 && total > 0) {
      return (
        <EmptyState
          icon={ListChecks}
          title="No jobs on this page"
          description="The list has fewer pages than that."
          action={{ label: "Back to the first page", onClick: () => router.push(pageHref(0)) }}
        />
      );
    }

    return filtered ? (
      <EmptyState
        icon={FilterX}
        title="No jobs match these filters"
        description="Try a wider date range or fewer filters."
        action={{ label: "Clear filters", onClick: () => router.push(pathname) }}
      />
    ) : (
      <EmptyState
        icon={ListChecks}
        title="No jobs yet"
        description="Background work — such as account automation — appears here once it is queued."
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
              {["Created (UTC)", "Type", "State", "Attempts", "Worker", "Last error", ""].map(
                (label) => (
                  <TableHead key={label} className="text-caption text-foreground-muted">
                    {label}
                  </TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((job) => (
              <TableRow key={job.id}>
                <TableCell className="font-mono text-caption whitespace-nowrap text-foreground-muted">
                  <time dateTime={job.createdAt}>{utc(job.createdAt).replace(" UTC", "")}</time>
                </TableCell>
                <TableCell className="max-w-56">
                  <div className="truncate font-mono text-caption text-foreground">{job.type}</div>
                  <div className="truncate font-mono text-caption text-foreground-subtle">
                    {job.id.slice(0, 8)}
                  </div>
                </TableCell>
                <TableCell>
                  <StateBadge job={job} />
                </TableCell>
                <TableCell className="text-description whitespace-nowrap text-foreground">
                  {job.attempts} / {job.maxAttempts}
                </TableCell>
                <TableCell className="max-w-40 truncate text-caption text-foreground-muted">
                  {job.claimedBy ?? "—"}
                </TableCell>
                <TableCell className="max-w-md">
                  <span className="line-clamp-2 text-caption text-foreground-muted">
                    {job.lastError ?? "—"}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => setOpen(job)}>
                    Details
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="flex flex-col gap-2 lg:hidden">
        {items.map((job) => (
          <li key={job.id}>
            <button
              type="button"
              onClick={() => setOpen(job)}
              className="flex w-full flex-col gap-1.5 rounded-lg border border-border bg-surface p-3 text-left"
            >
              <div className="flex items-center justify-between gap-2">
                <StateBadge job={job} />
                <time
                  dateTime={job.createdAt}
                  className="font-mono text-caption text-foreground-subtle"
                >
                  {utc(job.createdAt)}
                </time>
              </div>
              <span className="font-mono text-caption break-all text-foreground">{job.type}</span>
              <span className="text-caption text-foreground-muted">
                Attempts {job.attempts} / {job.maxAttempts}
                {job.lastError ? ` · ${job.lastError}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
        <p className="text-caption text-foreground-subtle">
          {total} job{total === 1 ? "" : "s"} · page {page} of {pageCount}
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

      <JobDetailDialog job={open} canManage={canManage} onClose={() => setOpen(null)} />
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

export function JobDetailDialog({
  job,
  canManage,
  onClose,
}: {
  job: JobListItem | null;
  canManage: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const cancel = useMutation({
    mutationFn: async (id: string) => {
      const result = await cancelJobAction(id);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: () => {
      toast.success("Job cancelled", { description: "It will not run." });
      onClose();
      router.refresh();
    },
    onError: (error) => toast.error("Could not cancel", { description: error.message }),
  });

  return (
    <Dialog open={job !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        {job ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-mono break-all">{job.type}</DialogTitle>
              <DialogDescription>
                A job&apos;s payload and result are never shown here — only its lifecycle.
              </DialogDescription>
            </DialogHeader>

            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="State">
                <StateBadge job={job} />
              </Field>
              <Field label="Job ID">
                <span className="font-mono text-caption break-all">{job.id}</span>
              </Field>
              <Field label="Priority">{job.priority}</Field>
              <Field label="Attempts">
                {job.attempts} of {job.maxAttempts}
              </Field>
              <Field label="Created">{utc(job.createdAt)}</Field>
              <Field label="Available from">{utc(job.availableAt)}</Field>
              <Field label="Started">{utc(job.startedAt)}</Field>
              <Field label="Last heartbeat">{utc(job.heartbeatAt)}</Field>
              <Field label="Finished">{utc(job.finishedAt)}</Field>
              <Field label="Worker">{job.claimedBy ?? "—"}</Field>
              {job.cancelledAt ? <Field label="Cancelled">{utc(job.cancelledAt)}</Field> : null}
              {job.recoveredAt ? (
                <Field label="Recovered from a silent worker">{utc(job.recoveredAt)}</Field>
              ) : null}
              <Field label="Last error">
                {job.lastError ? (
                  <>
                    {job.lastError}
                    {job.lastErrorCode ? (
                      <span className="block font-mono text-caption text-foreground-subtle">
                        {job.lastErrorCode}
                      </span>
                    ) : null}
                  </>
                ) : (
                  "—"
                )}
              </Field>
            </dl>

            {canManage && job.cancellable ? (
              <div className="flex justify-end">
                <Button
                  variant="destructive"
                  onClick={() => cancel.mutate(job.id)}
                  loading={cancel.isPending}
                  disabled={cancel.isPending}
                >
                  Cancel job
                </Button>
              </div>
            ) : job.state === "running" || job.state === "stale" ? (
              <p className="text-caption text-foreground-subtle">
                A running job cannot be cancelled: its work may already have happened.
              </p>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
