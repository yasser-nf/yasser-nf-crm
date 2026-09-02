"use client";

import { Trash2, TriangleAlert, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/shared/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { useDeleteAccounts } from "../hooks/use-account-mutations";
import { BulkDeclareProblemDialog, BulkResolveProblemsDialog } from "./bulk-problem-dialogs";
import { selectionLabel } from "../services/account-selection";

/**
 * Bulk action bar.
 *
 * Appears only while something is selected, above the table, and says exactly
 * what is selected before offering anything destructive.
 *
 * The bar holds the mutation rather than the table, so the table keeps owning
 * selection and nothing else. `ids` arrives already narrowed to rows currently
 * on screen — see `actionableIds`.
 */
export function BulkSelectionBar({
  ids,
  withProblem,
  withoutProblem,
  onClear,
}: {
  readonly ids: readonly string[];
  /**
   * Selected accounts that already have an open problem, and those that do not.
   *
   * Passed separately rather than derived here, because only the table knows
   * each row s problem state. The two problem actions are opposites, so each is
   * offered for the accounts it applies to and hidden when that set is empty —
   * which is what makes a mixed selection safe rather than ambiguous.
   */
  readonly withProblem: readonly string[];
  readonly withoutProblem: readonly string[];
  /** Called after a successful action, and by "Clear selection". */
  readonly onClear: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const remove = useDeleteAccounts();

  if (ids.length === 0) {
    return null;
  }

  function confirmDelete() {
    /*
     * Belt and braces against a double submit. The button is disabled while
     * `loading`, which is the real guard, but a second call could still arrive
     * from a keyboard repeat before React re-renders.
     */
    if (remove.isPending) {
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
         * `role="status"` rather than an alert: the bar appearing is useful
         * information, but it is the operator's own doing and must not
         * interrupt them.
         */
        role="status"
        className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <p className="text-caption font-medium text-foreground">{selectionLabel(ids.length)}</p>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(true)}
            loading={remove.isPending}
            loadingLabel="Deleting"
            className="gap-2 text-danger hover:bg-danger-subtle hover:text-danger"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Delete
          </Button>

          <BulkResolveProblemsDialog accountIds={withProblem} onDone={onClear} />

          <BulkDeclareProblemDialog accountIds={withoutProblem} onDone={onClear} />

          <Button variant="outline" size="sm" onClick={onClear} className="gap-2">
            <X className="size-4" aria-hidden="true" />
            Clear selection
          </Button>
        </div>
      </div>

      <AlertDialog
        open={confirming}
        /*
         * A delete in flight cannot be dismissed by Escape or a click outside.
         * Closing would not cancel the request, it would only hide it, and the
         * operator would be left guessing whether it happened.
         */
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
            <AlertDialogDescription>
              This action will remove the selected accounts. Please make sure you really want to
              continue.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            {/*
              Deliberately not AlertDialogCancel and AlertDialogAction. Both
              close the dialog the moment they are clicked, which would hide the
              loading state this button is required to show — and the shared
              Button renders no spinner through `asChild` anyway.
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
              loading={remove.isPending}
              loadingLabel="Deleting"
              className="bg-danger text-white hover:bg-danger/90"
            >
              Delete accounts
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
