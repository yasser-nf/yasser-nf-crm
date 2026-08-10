"use client";

import { useMutation } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { CircleCheck, LoaderCircle, ShieldCheck, TriangleAlert, UserX } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { ROUTES } from "@/config/constants";
import { DURATION, EASING } from "@/config/theme";
import { ActionError } from "@/lib/errors";
import { Button } from "@/shared/ui/button";
import type { BackupRow } from "@/lib/drizzle/schema";
import {
  previewRestoreAction,
  restoreBackupAction,
  verifyBackupAction,
  type ActionResult,
} from "../actions/backup.actions";
import type { RestorePreview } from "../services/restore.service";
import { ChecksumChip, StatusBadge, formatBytes } from "./backups-table";

/**
 * Backup detail, and the restore flow.
 *
 * Restore is deliberately two steps. The M07 brief: never restore immediately.
 * The button that applies changes does not exist until a preview has been
 * produced and read — a destructive action reached in one click is a destructive
 * action taken by accident.
 */

function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code);
}

function formatDateTime(value: Date | string | null): string {
  return value
    ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";
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
    mutationFn: async () => unwrap(await restoreBackupAction(backup.id)),
    onSuccess: (outcome) => {
      toast.success("Restore complete", {
        description:
          outcome.orphans.length > 0
            ? `${outcome.orphans.length} user(s) could not be restored — see the orphan report.`
            : "Every table was restored.",
      });
      setPreview(null);
      router.refresh();
    },
    onError: (error) => toast.error("Restore failed", { description: error.userMessage }),
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

        {preview ? (
          <PreviewPanel
            preview={preview}
            onApply={() => restore.mutate()}
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

function PreviewPanel({
  preview,
  onApply,
  applying,
}: {
  preview: RestorePreview;
  onApply: () => void;
  applying: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASING.out }}
      className="flex flex-col gap-4 rounded-md border border-border bg-background-secondary p-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <CircleCheck className="size-4 text-success" aria-hidden="true" />
        <span className="text-description text-foreground">
          Checksum verified — this backup is intact.
        </span>
      </div>

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

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <Button onClick={onApply} disabled={applying} className="gap-2">
          {applying ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
          Confirm restore
        </Button>
        <span className="text-caption text-foreground-subtle">
          Everything runs in one transaction. If any table fails, nothing changes.
        </span>
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
