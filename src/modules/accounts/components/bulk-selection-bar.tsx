"use client";

import { CircleCheck, Trash2, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ROUTES } from "@/config/constants";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { useDeleteAccounts } from "../hooks/use-account-mutations";
import {
  BulkNoteButton,
  CopyCredentialsButton,
  CopyEmailsButton,
  type SelectedAccount,
} from "./bulk-account-actions";
import { BulkDeclareProblemDialog, BulkResolveProblemsDialog } from "./bulk-problem-dialogs";
import { selectionLabel } from "../services/account-selection";

/**
 * The bulk action toolbar. Absent until something is selected.
 *
 * Every action receives exactly the selected rows that are on screen — the
 * table never hands over an id from another page, and it clears the selection
 * whenever the page, search, filter or sort changes. The toolbar says so, so a
 * cleared selection is never a surprise.
 *
 * What the operator may do is decided on the server for every action. The two
 * `can*` flags only stop a control being offered to someone the server would
 * refuse anyway.
 */
export function BulkSelectionBar({
  accounts,
  withProblem,
  withoutProblem,
  canDelete,
  canEditNotes,
  onClear,
}: {
  /** The selected rows on this page, in display order. */
  readonly accounts: readonly SelectedAccount[];
  readonly withProblem: readonly string[];
  readonly withoutProblem: readonly string[];
  /** DELETE_ACCOUNTS — Super Admin. */
  readonly canDelete: boolean;
  /** EDIT_ACCOUNTS — the account note's permission. */
  readonly canEditNotes: boolean;
  readonly onClear: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const remove = useDeleteAccounts();

  const ids = accounts.map((account) => account.id);

  if (ids.length === 0) {
    return null;
  }

  function openConfirm() {
    setUnderstood(false);
    setConfirming(true);
  }

  function confirmDelete() {
    /*
     * The disabled button is the real guard; this catches a key repeat that
     * lands before the re-render disables it.
     */
    if (remove.isPending || !understood) {
      return;
    }

    remove.mutate(ids, {
      onSuccess: () => {
        setConfirming(false);
        onClear();
      },
      /* Left open on failure so the operator can read the toast and retry. */
    });
  }

  return (
    <>
      <div
        /*
         * A status region, so a screen reader hears the count change as rows
         * are ticked, without the toolbar stealing focus.
         */
        role="status"
        className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 lg:flex-row lg:items-center lg:justify-between"
      >
        <div className="flex flex-col">
          <p className="text-caption font-medium text-foreground">{selectionLabel(ids.length)}</p>
          <p className="text-caption text-foreground-subtle">
            On this page only. Changing page, search, filter or sort clears it.
          </p>
        </div>

        {/* Wraps rather than scrolls, so every action stays reachable on a phone. */}
        <div className="flex flex-wrap items-center gap-1">
          <CopyEmailsButton accounts={accounts} />
          <CopyCredentialsButton accounts={accounts} />
          {canEditNotes ? <BulkNoteButton accounts={accounts} /> : null}

          {/*
            Resolve acts only on selected accounts that carry a blocking problem.
            The Accounts list no longer shows those (they are under Problems), so
            normally there are none and the control says where to go instead of
            pretending to do something.
          */}
          {withProblem.length > 0 ? (
            <BulkResolveProblemsDialog accountIds={withProblem} onDone={onClear} />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled
              title="No selected account has a blocking problem. Resolve problems from the Problems page."
              className="gap-2"
            >
              <CircleCheck className="size-4" aria-hidden="true" />
              Resolve
            </Button>
          )}

          <BulkDeclareProblemDialog accountIds={withoutProblem} onDone={onClear} />

          {canDelete ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={openConfirm}
              loading={remove.isPending}
              loadingLabel="Deleting"
              className="gap-2 text-danger hover:bg-danger-subtle hover:text-danger"
            >
              <Trash2 className="size-4" aria-hidden="true" />
              Delete
            </Button>
          ) : null}

          <Button variant="outline" size="sm" onClick={onClear} className="gap-2">
            <X className="size-4" aria-hidden="true" />
            Clear selection
          </Button>
        </div>
      </div>

      {withProblem.length === 0 ? (
        <p className="-mt-2 text-caption text-foreground-subtle">
          Accounts with a blocking problem are managed from{" "}
          <Link href={`${ROUTES.PROBLEMS}?status=blocking`} className="text-primary underline">
            Problems
          </Link>
          .
        </p>
      ) : null}

      <AlertDialog
        open={confirming}
        /* A delete in flight cannot be dismissed: closing would hide it, not stop it. */
        onOpenChange={(next) => {
          if (!remove.isPending) {
            setConfirming(next);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-danger" aria-hidden="true" />
              Delete {ids.length} account{ids.length === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2">
                <p>
                  This affects all {ids.length} selected account{ids.length === 1 ? "" : "s"}.
                </p>
                <p>
                  Deleting marks an account deleted: it disappears from Accounts, Problems, Quick
                  Prepare and Quick Replace, and none of its profiles can be sold again. The record
                  and its history are kept, but a deleted account cannot be restored from the app.
                  Archive instead if you may need it again.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <label className="flex items-start gap-2 text-caption text-foreground">
            <Checkbox
              checked={understood}
              onCheckedChange={(checked) => setUnderstood(checked === true)}
              disabled={remove.isPending}
              aria-label={`I understand ${ids.length} accounts will be deleted`}
            />
            <span>
              I understand {ids.length} account{ids.length === 1 ? "" : "s"} will be deleted.
            </span>
          </label>

          <AlertDialogFooter>
            {/*
              Deliberately not AlertDialogCancel and AlertDialogAction. Both
              close the dialog the moment they are clicked, which would hide the
              loading state this button is required to show.
            */}
            <Button
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={remove.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={confirmDelete}
              disabled={!understood}
              loading={remove.isPending}
              loadingLabel="Deleting"
              className="bg-danger text-white hover:bg-danger/90"
            >
              Delete {ids.length} account{ids.length === 1 ? "" : "s"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
