"use client";

import { useMutation } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Camera, DatabaseBackup, Download, LoaderCircle, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { toast } from "sonner";

import { ROUTES } from "@/config/constants";
import { DURATION, EASING } from "@/config/theme";
import { ActionError } from "@/lib/errors";
import { EmptyState } from "@/shared/feedback/empty-state";
import { Button } from "@/shared/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import { cn } from "@/utils/cn";
import {
  createBackupAction,
  exportBackupAction,
  importBackupAction,
  type ActionResult,
} from "../actions/backup.actions";
import type { BackupListEntry } from "../repositories/backups.repository";

/**
 * Backup list.
 *
 * Every control is a convenience. The services refuse the same operations
 * independently, so removing a button changes what is easy, not what is allowed.
 */

function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code);
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return "—";
  }

  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-surface-raised text-foreground-muted",
  running: "bg-primary-subtle text-primary",
  completed: "bg-success-subtle text-success",
  verified: "bg-success-subtle text-success",
  failed: "bg-danger-subtle text-danger",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-1 text-caption font-medium",
        STATUS_STYLES[status] ?? "bg-surface-raised text-foreground-muted",
      )}
    >
      {status}
    </span>
  );
}

/** Checksums are 64 hex characters. Nobody reads one; they compare the ends. */
export function ChecksumChip({ checksum }: { checksum: string | null }) {
  if (!checksum) {
    return <span className="text-foreground-subtle">—</span>;
  }

  return (
    <span title={checksum} className="font-mono text-caption text-foreground-muted">
      {checksum.slice(0, 8)}…{checksum.slice(-4)}
    </span>
  );
}

export function CreateBackupControls({ storageReady }: { storageReady: boolean }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  const create = useMutation({
    mutationFn: async (type: "manual" | "snapshot") => unwrap(await createBackupAction(type)),
    onSuccess: (backup) => {
      toast.success("Backup created", { description: backup.name });
      router.refresh();
    },
    onError: (error) => toast.error("Backup failed", { description: error.userMessage }),
  });

  const importFile = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return unwrap(await importBackupAction(formData));
    },
    onSuccess: () => {
      toast.success("Backup imported");
      router.refresh();
    },
    onError: (error) => toast.error("Import refused", { description: error.userMessage }),
  });

  const busy = create.isPending || importFile.isPending;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        onClick={() => create.mutate("manual")}
        disabled={busy || !storageReady}
        className="gap-2"
      >
        {create.isPending ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <DatabaseBackup className="size-4" aria-hidden="true" />
        )}
        Manual backup
      </Button>

      <Button
        variant="outline"
        onClick={() => create.mutate("snapshot")}
        disabled={busy || !storageReady}
        className="gap-2"
      >
        <Camera className="size-4" aria-hidden="true" />
        Snapshot
      </Button>

      <Button
        variant="outline"
        onClick={() => fileInput.current?.click()}
        disabled={busy || !storageReady}
        className="gap-2"
      >
        <Upload className="size-4" aria-hidden="true" />
        Import
      </Button>

      <input
        ref={fileInput}
        type="file"
        accept=".gz,application/gzip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) importFile.mutate(file);
          event.target.value = "";
        }}
      />
    </div>
  );
}

function DownloadButton({ id }: { id: string }) {
  const download = useMutation({
    mutationFn: async () => unwrap(await exportBackupAction(id)),
    onSuccess: ({ url }) => {
      /*
       * The signed URL is opened rather than fetched. Streaming megabytes back
       * through a Server Action would put the whole artifact in the RSC payload.
       */
      window.location.href = url;
    },
    onError: (error) => toast.error("Download failed", { description: error.userMessage }),
  });

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => download.mutate()}
      disabled={download.isPending}
      className="gap-1.5"
    >
      <Download className="size-3.5" aria-hidden="true" />
      Export
    </Button>
  );
}

export function BackupsTable({ items }: { items: readonly BackupListEntry[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={DatabaseBackup}
        title="No backups yet"
        description="Create a manual backup to protect the current state of the CRM."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="hidden overflow-x-auto rounded-lg border border-border lg:block">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-surface">
            <TableRow className="hover:bg-transparent">
              {["Name", "Type", "Status", "Created by", "Size", "Checksum", "Version", ""].map(
                (label) => (
                  <TableHead key={label} className="text-caption text-foreground-muted">
                    {label}
                  </TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>

          <TableBody>
            {items.map((entry, index) => (
              <motion.tr
                key={entry.backup.id}
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
                    href={`${ROUTES.BACKUPS}/${entry.backup.id}`}
                    className="text-foreground hover:text-primary"
                  >
                    {entry.backup.name}
                  </Link>
                </TableCell>
                <TableCell className="text-caption text-foreground-muted">
                  {entry.backup.type}
                  {entry.backup.isRestorePoint ? (
                    <span className="ml-1.5 text-foreground-subtle">· restore point</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <StatusBadge status={entry.backup.status} />
                </TableCell>
                <TableCell className="text-caption text-foreground-muted">
                  {entry.createdByName ?? "Scheduled"}
                </TableCell>
                <TableCell className="text-caption text-foreground-muted">
                  {formatBytes(entry.backup.sizeBytes)}
                </TableCell>
                <TableCell>
                  <ChecksumChip checksum={entry.backup.checksum} />
                </TableCell>
                <TableCell className="text-caption text-foreground-muted">
                  v{entry.backup.formatVersion}
                </TableCell>
                <TableCell>
                  {entry.backup.filename ? <DownloadButton id={entry.backup.id} /> : null}
                </TableCell>
              </motion.tr>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile — cards, per 04_UI_GUIDELINES.md */}
      <div className="flex flex-col gap-3 lg:hidden">
        {items.map((entry) => (
          <Link
            key={entry.backup.id}
            href={`${ROUTES.BACKUPS}/${entry.backup.id}`}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="truncate text-card-title text-foreground">{entry.backup.name}</span>
              <StatusBadge status={entry.backup.status} />
            </div>
            <div className="flex flex-wrap items-center gap-3 text-caption text-foreground-subtle">
              <span>{entry.backup.type}</span>
              <span>{formatBytes(entry.backup.sizeBytes)}</span>
              <ChecksumChip checksum={entry.backup.checksum} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
