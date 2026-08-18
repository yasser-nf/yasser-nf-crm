"use client";

import { useMutation } from "@tanstack/react-query";
import { Check, FileUp, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { ActionError } from "@/lib/errors";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { cn } from "@/utils/cn";
import {
  createAccountsInBulkAction,
  previewBulkAccountsAction,
  type ActionResult,
} from "../actions/account.actions";
import type { BulkPreview } from "../services/bulk-accounts.service";
import type { BulkCreateResult } from "../services/accounts.service";

/**
 * Bulk account import.
 *
 * A thin client over the Phase B backend. It owns no parsing, no validation and
 * no duplicate detection: the textarea's contents are sent as an opaque string
 * to `previewBulkAccountsAction` to look at, and to `createAccountsInBulkAction`
 * to write. Both run the same parser and the same `accountInsertSchema` a single
 * creation uses.
 *
 * That split matters for one specific reason. If this component parsed locally
 * to render the preview, an operator would approve rows produced by the
 * browser's idea of quoting and delimiter detection, while the server imported
 * rows produced by its own. They would agree almost always, and the
 * disagreement would be a password split on a comma.
 *
 * NO PASSWORD IS EVER RENDERED. The preview reports whether a row has one, and
 * nothing else about it — the operator can already see their own paste in the
 * textarea above, so echoing credentials into a second surface would add risk
 * without adding information.
 */

const TEMPLATE = "email,password,country,duration,profiles";

const EXAMPLE = [
  "email,password,country,duration,profiles",
  "stock01@example.com,SomePassword1,DZ,90,5",
  "stock02@example.com,SomePassword2,FR,30,3",
].join("\n");

function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

export function BulkAccountsDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <FileUp className="size-4" aria-hidden="true" />
          Bulk add
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Bulk add accounts</DialogTitle>
          <DialogDescription>
            Paste one account per line. Commas, tabs and semicolons are all detected automatically,
            so a copy from a spreadsheet works as-is.
          </DialogDescription>
        </DialogHeader>

        {/* Remounted per opening, so a finished import never greets the next one. */}
        {open ? <BulkForm onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function BulkForm({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [result, setResult] = useState<BulkCreateResult | null>(null);

  const parse = useMutation({
    mutationFn: async (input: string) => unwrap(await previewBulkAccountsAction(input)),
    onSuccess: setPreview,
    onError: (error) => toast.error("Could not read that", { description: error.message }),
  });

  const submit = useMutation({
    mutationFn: async (input: string) => unwrap(await createAccountsInBulkAction(input)),
    onSuccess: (data) => {
      setResult(data);

      if (data.created.length > 0) {
        router.refresh();
      }

      if (data.rejected.length === 0) {
        toast.success(
          `${data.created.length} account${data.created.length === 1 ? "" : "s"} created`,
        );
      } else if (data.created.length === 0) {
        toast.error("Nothing was imported", {
          description: `All ${data.submitted} rows were rejected.`,
        });
      } else {
        toast.warning(`${data.created.length} of ${data.submitted} imported`, {
          description: `${data.rejected.length} row${data.rejected.length === 1 ? "" : "s"} rejected.`,
        });
      }
    },
    onError: (error) =>
      toast.error("Could not import", {
        description: error instanceof ActionError ? error.userMessage : "Please try again.",
      }),
  });

  const isBusy = parse.isPending || submit.isPending;
  const hasText = text.trim() !== "";

  /* A finished import replaces the form: the same paste must not be sent twice. */
  if (result) {
    return (
      <BulkResult
        result={result}
        onClose={onDone}
        onAgain={() => {
          setResult(null);
          setPreview(null);
          setText("");
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="bulk-rows" className="text-description font-medium text-foreground">
          Accounts
        </Label>

        <Textarea
          id="bulk-rows"
          rows={8}
          spellCheck={false}
          autoComplete="off"
          placeholder={EXAMPLE}
          value={text}
          disabled={isBusy}
          onChange={(event) => {
            setText(event.target.value);
            /* A stale preview must never be what gets confirmed. */
            setPreview(null);
          }}
          className="bg-background-secondary font-mono text-caption"
        />

        <p className="text-caption text-foreground-subtle">
          Columns: <span className="font-mono">{TEMPLATE}</span>. Country, duration and profiles are
          optional — profiles defaults to 5 and a missing duration means open-ended. A header row is
          detected and skipped.
        </p>
      </div>

      {preview ? <BulkPreviewTable preview={preview} /> : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onDone} disabled={isBusy}>
          Cancel
        </Button>

        <Button
          variant="outline"
          onClick={() => parse.mutate(text)}
          disabled={!hasText || isBusy}
          className="gap-2"
        >
          {parse.isPending ? (
            <>
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Reading
            </>
          ) : (
            "Preview rows"
          )}
        </Button>

        <Button
          onClick={() => submit.mutate(text)}
          /*
           * Requires a preview first: an operator should see what the server
           * read before it writes anything. Also blocks a second click while
           * the first is in flight.
           */
          disabled={!hasText || isBusy || preview === null || preview.validCount === 0}
          className="min-w-40 gap-2"
        >
          {submit.isPending ? (
            <>
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Importing
            </>
          ) : preview ? (
            `Import ${preview.validCount} account${preview.validCount === 1 ? "" : "s"}`
          ) : (
            "Import"
          )}
        </Button>
      </div>
    </div>
  );
}

/** What the server read, before anything is written. */
function BulkPreviewTable({ preview }: { preview: BulkPreview }) {
  const delimiterName =
    preview.delimiter === "\t"
      ? "tab-separated"
      : preview.delimiter === ";"
        ? "semicolon-separated"
        : "comma-separated";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption">
        <span className="text-foreground-muted">
          Read as <span className="text-foreground">{delimiterName}</span>
          {preview.headerDropped ? " · header row skipped" : ""}
        </span>
        <span className="text-success">{preview.validCount} valid</span>
        {preview.invalidCount > 0 ? (
          <span className="text-danger">{preview.invalidCount} invalid</span>
        ) : null}
      </div>

      <div className="max-h-64 overflow-y-auto rounded-md border border-border">
        <table className="w-full text-caption">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-border text-left text-foreground-muted">
              <th className="px-3 py-2 font-medium">Line</th>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Country</th>
              <th className="px-3 py-2 font-medium">Days</th>
              <th className="px-3 py-2 font-medium">Profiles</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <tr
                key={`${row.line}-${row.email ?? "unknown"}`}
                className={cn(
                  "border-b border-border last:border-0",
                  !row.valid && "bg-danger-subtle",
                )}
              >
                <td className="px-3 py-2 text-foreground-subtle tabular-nums">{row.line}</td>
                <td className="px-3 py-2 font-mono text-foreground">{row.email ?? "—"}</td>
                <td className="px-3 py-2 text-foreground-muted">{row.country ?? "—"}</td>
                <td className="px-3 py-2 text-foreground-muted tabular-nums">
                  {row.durationDays ?? "open"}
                </td>
                <td className="px-3 py-2 text-foreground-muted tabular-nums">
                  {row.profileSlots ?? "—"}
                </td>
                <td className="px-3 py-2">
                  {row.valid ? (
                    <span className="inline-flex items-center gap-1 text-success">
                      <Check className="size-3" aria-hidden="true" />
                      Ready
                      {row.hasPassword ? "" : " · no password"}
                    </span>
                  ) : (
                    <span className="flex flex-col gap-0.5 text-danger">
                      <span className="inline-flex items-center gap-1">
                        <X className="size-3" aria-hidden="true" />
                        {row.message}
                      </span>
                      {Object.entries(row.fieldErrors).map(([field, message]) => (
                        <span key={field} className="text-foreground-muted">
                          <span className="font-mono">{field}</span>: {message}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The outcome. Every submitted row appears exactly once. */
function BulkResult({
  result,
  onClose,
  onAgain,
}: {
  result: BulkCreateResult;
  onClose: () => void;
  onAgain: () => void;
}) {
  const accountedFor = result.created.length + result.rejected.length;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Tally label="Submitted" value={result.submitted} tone="text-foreground" />
        <Tally label="Created" value={result.created.length} tone="text-success" />
        <Tally label="Rejected" value={result.rejected.length} tone="text-danger" />
      </div>

      {/*
        The arithmetic is shown rather than assumed. If the backend ever returns
        a batch where the three numbers disagree, the operator sees it here
        instead of quietly losing a row.
      */}
      {accountedFor !== result.submitted ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle p-3 text-caption text-warning"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {accountedFor} of {result.submitted} rows are accounted for. Check the accounts list
          before importing again.
        </p>
      ) : null}

      {result.rejected.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-card-title text-foreground">Rejected rows</p>

          <ul className="flex flex-col gap-2">
            {result.rejected.map((row) => (
              <li
                key={`${row.line}-${row.email ?? "unknown"}`}
                className="flex flex-col gap-1 rounded-md border border-danger/30 bg-danger-subtle p-3 text-caption"
              >
                <span className="text-foreground">
                  Line {row.line}
                  {row.email ? (
                    <span className="ml-2 font-mono text-foreground-muted">{row.email}</span>
                  ) : null}
                </span>
                <span className="text-danger">{row.message}</span>
                {Object.entries(row.fieldErrors).map(([field, message]) => (
                  <span key={field} className="text-foreground-muted">
                    <span className="font-mono">{field}</span>: {message}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onAgain}>
          Import more
        </Button>
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

function Tally({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-background-secondary p-3">
      <span className="text-caption text-foreground-subtle">{label}</span>
      <span className={cn("text-section-title tabular-nums", tone)}>{value}</span>
    </div>
  );
}
