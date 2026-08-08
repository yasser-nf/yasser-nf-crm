"use client";

import { Check, Copy, LoaderCircle, RefreshCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { copyToClipboard } from "@/lib/clipboard";
import type { AccountRow } from "@/lib/drizzle/schema";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { useReplaceAllocation } from "../hooks/use-quick-prepare";
import type { PreparationResult } from "../services/quick-prepare.service";

/**
 * Replace Account.
 *
 * The brief lists exactly when this applies: Payment Problem, Incorrect
 * Password, Invalid Email, Something Went Wrong. The button is rendered only for
 * those statuses — offering it on a healthy account would invite a worker to
 * move a customer for no reason and burn stock.
 *
 * Archived and deleted are excluded too. Those are lifecycle states rather than
 * faults, and an archived account's customers should be handled deliberately.
 */

/** The four fault statuses from the brief. */
const REPLACEABLE_STATUSES: readonly AccountRow["status"][] = [
  "payment_problem",
  "incorrect_password",
  "invalid_email",
  "something_went_wrong",
];

export function canReplaceAllocation(status: AccountRow["status"]): boolean {
  return REPLACEABLE_STATUSES.includes(status);
}

export function ReplaceAccountButton({
  account,
  customerId,
  customerLabel,
  profileCount,
}: {
  account: AccountRow;
  customerId: string;
  customerLabel: string;
  profileCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<PreparationResult | null>(null);
  const [copied, setCopied] = useState(false);

  const replace = useReplaceAllocation();

  if (!canReplaceAllocation(account.status)) {
    return null;
  }

  async function copy() {
    if (!result) {
      return;
    }

    const success = await copyToClipboard(result.clipboardText);

    if (!success) {
      toast.error("Could not copy", { description: "Your browser blocked clipboard access." });
      return;
    }

    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        className="gap-2 border-warning/40 text-warning hover:bg-warning-subtle hover:text-warning"
      >
        <RefreshCcw className="size-4" aria-hidden="true" />
        Replace account
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!replace.isPending) {
            setOpen(next);
            if (!next) {
              setResult(null);
              replace.reset();
            }
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Replace this account</DialogTitle>
            <DialogDescription>
              {profileCount} profile{profileCount === 1 ? "" : "s"} held by {customerLabel} will be
              released and reallocated to healthy stock. The customer keeps their original
              expiration date.
            </DialogDescription>
          </DialogHeader>

          {result ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-card-title text-foreground">New credentials</p>
                <Button size="sm" onClick={copy} className="gap-2">
                  {copied ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Copy className="size-3.5" aria-hidden="true" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>

              <pre className="overflow-x-auto rounded-md bg-background-secondary p-4 font-mono text-caption whitespace-pre-wrap text-foreground">
                {result.clipboardText}
              </pre>

              <Button variant="ghost" onClick={() => setOpen(false)} className="self-end">
                Done
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-3">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={replace.isPending}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  replace.mutate(
                    { accountId: account.id, customerId, reason: account.status },
                    { onSuccess: setResult },
                  )
                }
                disabled={replace.isPending}
                className="min-w-40 gap-2"
              >
                {replace.isPending ? (
                  <>
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                    Reallocating
                  </>
                ) : (
                  <>
                    <RefreshCcw className="size-4" aria-hidden="true" />
                    Replace now
                  </>
                )}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
