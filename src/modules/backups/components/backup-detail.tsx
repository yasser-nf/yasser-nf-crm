"use client";

import { useMutation } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  CircleCheck,
  CircleX,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert,
  UserX,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { ROUTES } from "@/config/constants";
import { DURATION, EASING } from "@/config/theme";
import { ActionError } from "@/lib/errors";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import type { BackupRow } from "@/lib/drizzle/schema";
import {
  previewRestoreAction,
  restoreBackupAction,
  verifyBackupAction,
  type ActionResult,
} from "../actions/backup.actions";
import { RESTORE_CONFIRMATION } from "../services/backup-format";
import type { RestoreOutcome, RestorePreview } from "../services/restore.service";
import { ChecksumChip, StatusBadge, formatBytes } from "./backups-table";

/**
 * Backup detail, and the restore flow.
 *
 * Restore is deliberately two steps, and the second needs typing. The button
 * that applies changes does not exist until a preview — including a full
 * rehearsal the database accepted — has been produced, and it stays disabled
 * until RESTORE is typed. What is confirmed is bound to the previewed file by
 * its checksum, so a different file can never be applied by the same click.
 *
 * Times are shown in UTC, like the rest of the operational screens.
 */

function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code);
}

function formatDateTime(value: Date | string | null): string {
  return value ? `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC` : "—";
}

export function BackupDetailView({
  backup,
  createdByName,
}: {
  backup: BackupRow;
  createdByName: string | null;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [outcome, setOutcome] = useState<RestoreOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const tableCounts = (backup.tableCounts ?? {}) as Record<string, number>;

  const verify = useMutation({
    mutationFn: async () => unwrap(await verifyBackupAction(backup.id)),
    onSuccess: () => {
      toast.success("Checksum verified", { description: "The stored file is intact." });
      router.refresh();
    },
    onError: (error) => toast.error("Verification failed", { description: error.userMessage }),
  });

  const runPreview = useMutation({
    mutationFn: async () => unwrap(await previewRestoreAction(backup.id)),
    onSuccess: (result) => setPreview(result),
    onError: (error) => toast.error("Preview failed", { description: error.userMessage }),
  });

  const restore = useMutation({
    mutationFn: async ({ confirmation, checksum }: { confirmation: string; checksum: string }) =>
      unwrap(await restoreBackupAction(backup.id, { confirmation, expectedChecksum: checksum })),
    onMutate: () => {
      setOutcome(null);
      setFailure(null);
    },
    onSuccess: (result) => {
      toast.success("Restore complete");
      setOutcome(result);
      setPreview(null);
      router.refresh();
    },
    onError: (error) => {
      /* Shown in place, not only as a toast: a failed restore must not be missed. */
      setFailure(error.userMessage);
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={ROUTES.BACKUPS}
        className="inline-flex w-fit items-center gap-1.5 text-caption text-foreground-muted hover:text-foreground"
      >
        &larr; All backups
      </Link>

      <section className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-page-title text-foreground">{backup.name}</h1>
          <StatusBadge status={backup.status} />
          {backup.isRestorePoint ? (
            <span className="rounded-md bg-primary-subtle px-2 py-1 text-caption text-primary">
              Restore point
            </span>
          ) : null}
        </div>

        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Type" value={backup.type} />
          <Field label="Created" value={formatDateTime(backup.createdAt)} />
          <Field label="Created by" value={createdByName ?? "Scheduled"} />
          <Field label="Completed" value={formatDateTime(backup.completedAt)} />
          <Field label="Verified" value={formatDateTime(backup.verifiedAt)} />
          <Field label="Size" value={formatBytes(backup.sizeBytes)} />
          <Field label="Format version" value={`v${backup.formatVersion}`} />
          <Field label="App version" value={backup.appVersion ?? "—"} />
          <Field
            label="Database"
            value={backup.databaseVersion?.split(" ").slice(0, 2).join(" ") ?? "—"}
          />
        </dl>

        <div className="flex flex-col gap-1">
          <span className="text-caption text-foreground-subtle">Checksum (SHA-256)</span>
          <div className="flex items-center gap-2">
            <ChecksumChip checksum={backup.checksum} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => verify.mutate()}
              disabled={verify.isPending || !backup.filename}
              className="gap-1.5"
            >
              {verify.isPending ? (
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <ShieldCheck className="size-3.5" aria-hidden="true" />
              )}
              Verify integrity
            </Button>
          </div>
        </div>

        {backup.errorMessage ? (
          <p className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle p-3 text-caption text-danger">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {backup.errorMessage}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-section-title text-foreground">Tables included</h2>
        {Object.keys(tableCounts).length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-description text-foreground-muted">
            No table information recorded.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(tableCounts).map(([table, count]) => (
              <li
                key={table}
                className="flex items-center justify-between rounded-md bg-background-secondary px-4 py-2.5 text-caption"
              >
                <span className="font-mono text-foreground">{table}</span>
                <span className="text-foreground-subtle">{count} rows</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-section-title text-foreground">Restore</h2>
          <p className="text-caption text-foreground-muted">
            Nothing is restored until you review a preview and confirm. A snapshot of the current
            data is taken automatically before any restore is applied.
          </p>
        </div>

        <div>
          <Button
            variant="outline"
            onClick={() => runPreview.mutate()}
            disabled={runPreview.isPending || !backup.filename}
            className="gap-2"
          >
            {runPreview.isPending ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            Preview restore
          </Button>
        </div>

        {failure ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle p-4 text-description text-danger"
          >
            <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <strong className="block">Restore failed</strong>
              {failure}
            </span>
          </p>
        ) : null}

        {outcome ? <OutcomePanel outcome={outcome} /> : null}

        {preview ? (
          <PreviewPanel
            preview={preview}
            onApply={(confirmation) => restore.mutate({ confirmation, checksum: preview.checksum })}
            applying={restore.isPending}
          />
        ) : null}
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-foreground-subtle">{label}</dt>
      <dd className="text-description text-foreground">{value}</dd>
    </div>
  );
}

function OutcomePanel({ outcome }: { outcome: RestoreOutcome }) {
  const changed = outcome.effects.tables.filter((entry) => entry.before !== entry.after);

  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-md border border-success/30 bg-success-subtle p-4 text-caption text-foreground"
    >
      <span className="flex items-center gap-2 text-card-title">
        <CircleCheck className="size-4 text-success" aria-hidden="true" />
        Restore complete
      </span>
      <span className="text-foreground-muted">
        {changed.length === 0
          ? "The data already matched this backup."
          : changed.map((entry) => `${entry.table} ${entry.before} → ${entry.after}`).join(" · ")}
      </span>
      {outcome.safetySnapshotId ? (
        <Link
          href={`${ROUTES.BACKUPS}/${outcome.safetySnapshotId}`}
          className="w-fit text-primary hover:underline"
        >
          The snapshot taken just before this restore
        </Link>
      ) : null}
    </div>
  );
}

function PreviewPanel({
  preview,
  onApply,
  applying,
}: {
  preview: RestorePreview;
  onApply: (confirmation: string) => void;
  applying: boolean;
}) {
  const [typed, setTyped] = useState("");
  const confirmed = typed === RESTORE_CONFIRMATION;
  const changed = preview.effects.tables.filter((entry) => entry.before !== entry.after);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASING.out }}
      className="flex flex-col gap-4 rounded-md border border-border bg-background-secondary p-5"
    >
      <ul className="flex flex-col gap-1.5 text-description text-foreground">
        <li className="flex items-center gap-2">
          <CircleCheck className="size-4 text-success" aria-hidden="true" />
          File checksum verified — the stored file is intact.
        </li>
        <li className="flex items-center gap-2">
          {preview.contentVerified ? (
            <CircleCheck className="size-4 text-success" aria-hidden="true" />
          ) : (
            <TriangleAlert className="size-4 text-warning" aria-hidden="true" />
          )}
          {preview.contentVerified
            ? "Content hash verified — the data is exactly what was backed up."
            : `Format v${preview.formatVersion}: this older backup has no content hash.`}
        </li>
        <li className="flex items-center gap-2">
          <CircleCheck className="size-4 text-success" aria-hidden="true" />
          Rehearsed — the whole restore ran in a transaction the database accepted, then was rolled
          back.
        </li>
      </ul>

      <div className="flex flex-wrap gap-4">
        <Total label="Rows to create" value={preview.totals.create} tone="text-success" />
        <Total label="Rows to update" value={preview.totals.update} tone="text-warning" />
        <Total label="Rows to delete" value={preview.totals.delete} tone="text-danger" />
      </div>

      <ul className="flex flex-col gap-1.5">
        {preview.changes.map((change) => (
          <li
            key={change.table}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface px-4 py-2 text-caption"
          >
            <span className="font-mono text-foreground">
              {change.table}
              {change.policy === "append_only" ? (
                <span className="ml-2 text-foreground-subtle">append-only</span>
              ) : null}
            </span>
            <span className="text-foreground-muted">
              +{change.create} · ~{change.update} · −{change.delete}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-foreground">
          Measured effect on every table
        </span>
        {changed.length === 0 ? (
          <p className="text-caption text-foreground-muted">
            No table changes size — the data already matches this backup&apos;s row counts.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {changed.map((entry) => (
              <li
                key={entry.table}
                className="flex justify-between gap-2 rounded-md bg-surface px-4 py-1.5 text-caption"
              >
                <span className="font-mono text-foreground">{entry.table}</span>
                <span
                  className={entry.after < entry.before ? "text-danger" : "text-foreground-muted"}
                >
                  {entry.before} → {entry.after}
                </span>
              </li>
            ))}
          </ul>
        )}
        {preview.effects.linksCleared.length > 0 ? (
          <p className="text-caption text-foreground-muted">
            Links cleared because the row they pointed at is removed:{" "}
            {preview.effects.linksCleared
              .map((entry) => `${entry.reference} (${entry.count})`)
              .join(", ")}
          </p>
        ) : null}
      </div>

      {preview.orphans.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning-subtle p-4">
          <span className="flex items-center gap-2 text-card-title text-foreground">
            <UserX className="size-4 text-warning" aria-hidden="true" />
            Orphaned users ({preview.orphans.length})
          </span>
          <ul className="flex flex-col gap-1">
            {preview.orphans.map((orphan) => (
              <li key={orphan.id} className="text-caption text-foreground-muted">
                {orphan.email} — {orphan.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview.warnings.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-foreground">Warnings</span>
          {preview.warnings.map((warning) => (
            <p key={warning} className="text-caption text-foreground-muted">
              · {warning}
            </p>
          ))}
        </div>
      ) : null}

      {preview.conflicts.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-foreground">
            Conflicts ({preview.conflicts.length})
          </span>
          {preview.conflicts.slice(0, 10).map((conflict) => (
            <p key={conflict} className="text-caption text-foreground-muted">
              · {conflict}
            </p>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <p className="text-caption text-foreground-muted">
          A snapshot of the current data is taken first. Everything then runs in one transaction: if
          any table fails, nothing changes. Type{" "}
          <strong className="font-mono text-foreground">{RESTORE_CONFIRMATION}</strong> to confirm.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={RESTORE_CONFIRMATION}
            aria-label={`Type ${RESTORE_CONFIRMATION} to confirm the restore`}
            autoComplete="off"
            disabled={applying}
            className="h-10 sm:max-w-48"
          />
          <Button
            variant="destructive"
            onClick={() => onApply(typed)}
            disabled={applying || !confirmed}
            className="gap-2"
          >
            {applying ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            {applying ? "Restoring…" : "Restore this backup"}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

function Total({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-caption text-foreground-subtle">{label}</span>
      <span className={`text-section-title ${tone}`}>{value}</span>
    </div>
  );
}
