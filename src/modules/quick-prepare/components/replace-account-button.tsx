"use client";

import { Check, Copy, LoaderCircle, RefreshCcw, TriangleAlert } from "lucide-react";
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
import { useConfirmReplacement, usePreviewReplacement } from "../hooks/use-quick-prepare";
import type { PreparationResult } from "../services/quick-prepare.service";
import type { ReplacementPreview } from "../services/quick-replace.service";

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
 *
 * PREVIEW THEN CONFIRM, always.
 *
 * This used to call `replaceAllocationAction`, which committed immediately: no
 * bound replacement account, and no M13 §8 password-change gate. It was the last
 * path in the application that could reallocate a customer without either, and
 * it was reachable from this page by anyone with a session. It is gone — the
 * action, its hook and its service function were all deleted, not deprecated.
 *
 * The operator now sees what they are about to do, and the account they approve
 * is the account the transaction commits to or refuses on. There is exactly one
 * replacement path, and this is it.
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

/** Why no replacement could be offered, in the operator's words. */
function blockedMessage(preview: ReplacementPreview): string | null {
  switch (preview.blockedReason) {
    case "nothing_to_replace":
      return "Nobody holds a profile on this account, so there is nothing to replace.";
    case "no_stock":
      return "No healthy account has a free profile right now.";
    case "insufficient_validity": {
      const best = preview.bestAvailableDays;
      const needed = preview.selected?.remainingDays ?? 0;
      return best === null
        ? `No account has enough validity left to cover the remaining ${needed} days.`
        : `The best available account has ${best} day${best === 1 ? "" : "s"} left, and this customer needs ${needed}.`;
    }
    default:
      return preview.selected ? null : "Could not identify this customer's allocation.";
  }
}

export function ReplaceAccountButton({
  account,
  customerId,
  customerLabel,
  profileCount,
}: {
  /**
   * Only the fields this button reads, so it can accept a projection that has
   * dropped the credential. `email` is how the preview looks the account up.
   */
  account: Pick<AccountRow, "id" | "status" | "email">;
  customerId: string;
  customerLabel: string;
  profileCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ReplacementPreview | null>(null);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [result, setResult] = useState<PreparationResult | null>(null);
  const [copied, setCopied] = useState(false);

  const previewReplacement = usePreviewReplacement();
  const confirmReplacement = useConfirmReplacement();

  const busy = previewReplacement.isPending || confirmReplacement.isPending;

  if (!canReplaceAllocation(account.status)) {
    return null;
  }

  function start() {
    setOpen(true);
    setPreview(null);
    setResult(null);
    setPasswordChanged(false);

    previewReplacement.mutate(
      { accountEmail: account.email, customerId },
      { onSuccess: setPreview },
    );
  }

  function reset() {
    setPreview(null);
    setResult(null);
    setPasswordChanged(false);
    previewReplacement.reset();
    confirmReplacement.reset();
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

  /*
   * The commit is bound to what the preview showed: this exact replacement
   * account, and these exact held profiles. The server re-verifies both under
   * lock and refuses if either moved — the button cannot talk it into anything.
   */
  const replacement = preview?.replacement ?? null;
  const selected = preview?.selected ?? null;
  const blocked = preview ? blockedMessage(preview) : null;
  const canConfirm =
    replacement !== null &&
    selected !== null &&
    (!preview?.requiresPasswordChange || passwordChanged);

  return (
    <>
      <Button
        variant="outline"
        onClick={start}
        className="gap-2 border-warning/40 text-warning hover:bg-warning-subtle hover:text-warning"
      >
        <RefreshCcw className="size-4" aria-hidden="true" />
        Replace account
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) {
            setOpen(next);
            if (!next) {
              reset();
            }
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Replace this account</DialogTitle>
            <DialogDescription>
              {profileCount} profile{profileCount === 1 ? "" : "s"} held by {customerLabel} will be
              released and reallocated. The customer keeps their original expiration date.
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

              {result.requiresPasswordChange ? (
                <p className="flex items-start gap-2 rounded-md bg-warning-subtle p-3 text-caption text-warning">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  This account previously served another customer. Confirm the password was changed
                  before sending these credentials.
                </p>
              ) : null}

              <pre className="overflow-x-auto rounded-md bg-background-secondary p-4 font-mono text-caption whitespace-pre-wrap text-foreground">
                {result.clipboardText}
              </pre>

              <Button variant="ghost" onClick={() => setOpen(false)} className="self-end">
                Done
              </Button>
            </div>
          ) : previewReplacement.isPending ? (
            <p className="flex items-center gap-2 py-4 text-description text-foreground-muted">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Finding a replacement…
            </p>
          ) : blocked ? (
            <div className="flex flex-col gap-3">
              <p className="flex items-start gap-2 rounded-md bg-warning-subtle p-3 text-caption text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {blocked}
              </p>
              <Button variant="ghost" onClick={() => setOpen(false)} className="self-end">
                Close
              </Button>
            </div>
          ) : replacement && selected ? (
            <div className="flex flex-col gap-3">
              <dl className="flex flex-col gap-2 rounded-md bg-background-secondary p-3 text-caption">
                <div className="flex justify-between gap-3">
                  <dt className="text-foreground-muted">Remaining for this customer</dt>
                  <dd className="text-foreground">
                    {selected.remainingDays} day{selected.remainingDays === 1 ? "" : "s"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-foreground-muted">Moving to</dt>
                  <dd className="text-foreground">{replacement.account.email}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-foreground-muted">Profile</dt>
                  <dd className="text-foreground">
                    {replacement.profiles.map((profile) => profile.profileNumber).join(", ")}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-foreground-muted">That account&rsquo;s validity</dt>
                  <dd className="text-foreground">
                    {replacement.remainingValidityDays === null
                      ? "Open-ended"
                      : `${replacement.remainingValidityDays} days`}
                  </dd>
                </div>
              </dl>

              {preview?.problems.length ? (
                <p className="text-caption text-foreground-muted">
                  {preview.problems.length} open problem
                  {preview.problems.length === 1 ? "" : "s"} on this account.
                </p>
              ) : null}

              {preview?.requiresPasswordChange ? (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md bg-background-secondary p-3">
                  <input
                    type="checkbox"
                    checked={passwordChanged}
                    disabled={confirmReplacement.isPending}
                    onChange={(event) => setPasswordChanged(event.target.checked)}
                    className="mt-0.5 size-4 shrink-0 accent-primary"
                  />
                  <span className="text-caption text-foreground">
                    The replacement account previously served another customer. I have changed the
                    Netflix password on it.
                  </span>
                </label>
              ) : null}

              <div className="flex items-center justify-end gap-3">
                <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    confirmReplacement.mutate(
                      {
                        accountId: account.id,
                        customerId,
                        expectedProfileIds: selected.profiles.map((profile) => profile.id),
                        replacementAccountId: replacement.account.id,
                        reason: account.status,
                        passwordChangeConfirmed: passwordChanged,
                      },
                      { onSuccess: setResult },
                    )
                  }
                  disabled={busy || !canConfirm}
                  className="min-w-40 gap-2"
                >
                  {confirmReplacement.isPending ? (
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
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
