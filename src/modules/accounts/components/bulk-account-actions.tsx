"use client";

import { useMutation } from "@tanstack/react-query";
import { KeyRound, Mail, StickyNote } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { ActionError } from "@/lib/errors";
import { copyToClipboard, formatCredentialBlocks, formatEmailList } from "@/lib/clipboard";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { revealAccountCredentialsAction, setAccountNotesAction } from "../actions/account.actions";
import { AccountNoteDialog } from "./account-note-cell";

/**
 * The accounts toolbar's copy and note actions (M03 revision).
 *
 * Each acts on exactly the accounts it is handed — the selected rows that are
 * on screen, never an id from another page. The server re-checks everything a
 * mutation depends on; these components only decide what is offered.
 */

export interface SelectedAccount {
  readonly id: string;
  readonly email: string;
  readonly notes: string | null;
}

const NOTE_MAX = 2000;

function clipboardFailed() {
  toast.error("Could not copy", { description: "Your browser blocked clipboard access." });
}

/* ------------------------------------------------------------------ email */

/**
 * Copies the selected emails, one per line, in the order they appear.
 *
 * Nothing leaves the browser: the emails are already on screen.
 */
export function CopyEmailsButton({ accounts }: { readonly accounts: readonly SelectedAccount[] }) {
  async function copy() {
    const success = await copyToClipboard(formatEmailList(accounts.map((a) => a.email)));

    if (!success) {
      clipboardFailed();
      return;
    }

    toast.success(accounts.length === 1 ? "Email copied" : `${accounts.length} emails copied`);
  }

  return (
    <Button variant="ghost" size="sm" onClick={() => void copy()} className="gap-2">
      <Mail className="size-4" aria-hidden="true" />
      Copy email{accounts.length === 1 ? "" : "s"}
    </Button>
  );
}

/* ------------------------------------------------------------ credentials */

/**
 * Copies the selected accounts' credentials in the existing
 * `formatEmailAndPassword` layout, one block per account.
 *
 * The passwords are fetched on click through `revealAccountCredentialsAction`
 * — the same server-side decryption as the single-account copy — and live only
 * inside this handler: formatted, written to the clipboard, and dropped. They
 * are never put in React state, a query cache, storage, the URL, a toast or the
 * console. Deliberately not `useMutation`, which would keep the last result in
 * its cache for as long as the component lives.
 */
export function CopyCredentialsButton({
  accounts,
}: {
  readonly accounts: readonly SelectedAccount[];
}) {
  const [busy, setBusy] = useState(false);

  async function copy() {
    if (busy) {
      return;
    }

    setBusy(true);

    try {
      const result = await revealAccountCredentialsAction(accounts.map((a) => a.id));

      if (!result.ok) {
        /* The server's userMessage names no secret. */
        toast.error("Could not copy credentials", { description: result.message });
        return;
      }

      const success = await copyToClipboard(formatCredentialBlocks(result.data));

      if (!success) {
        clipboardFailed();
        return;
      }

      toast.success(
        result.data.length === 1
          ? "Credentials copied"
          : `Credentials for ${result.data.length} accounts copied`,
      );
    } catch {
      toast.error("Could not copy credentials", {
        description: "Something went wrong. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void copy()}
      loading={busy}
      loadingLabel="Copying"
      className="gap-2"
    >
      <KeyRound className="size-4" aria-hidden="true" />
      Copy credentials
    </Button>
  );
}

/* ------------------------------------------------------------------ notes */

/**
 * Add/Edit Note.
 *
 * One account: the existing account note editor, prefilled — the same dialog
 * the note cell opens.
 *
 * Several: a bulk dialog that says how many accounts it will write and how many
 * of them already carry a different note, and will not submit until the
 * operator ticks that they mean it. The server re-checks against the locked rows
 * and refuses, changing nothing, if a note appeared in the meantime.
 */
export function BulkNoteButton({ accounts }: { readonly accounts: readonly SelectedAccount[] }) {
  const [open, setOpen] = useState(false);
  const only = accounts.length === 1 ? accounts[0] : undefined;

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} className="gap-2">
        <StickyNote className="size-4" aria-hidden="true" />
        {only?.notes?.trim() ? "Edit note" : "Add note"}
      </Button>

      {open && only ? (
        <AccountNoteDialog
          accountId={only.id}
          accountEmail={only.email}
          note={only.notes}
          onClose={() => setOpen(false)}
        />
      ) : null}

      {open && !only ? <BulkNoteDialog accounts={accounts} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** How many of these accounts would lose a different, existing note. */
export function notesThatWouldBeReplaced(
  accounts: readonly SelectedAccount[],
  note: string,
): number {
  const next = note.trim();

  return accounts.filter((account) => {
    const current = account.notes?.trim() ?? "";
    return current !== "" && current !== next;
  }).length;
}

function BulkNoteDialog({
  accounts,
  onClose,
}: {
  readonly accounts: readonly SelectedAccount[];
  readonly onClose: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const replacing = notesThatWouldBeReplaced(accounts, draft);

  const save = useMutation({
    mutationFn: async () => {
      const result = await setAccountNotesAction(
        accounts.map((a) => a.id),
        {
          note: draft.trim(),
          confirmOverwrite: confirmed,
          /* What was on screen: the server refuses if any of it has changed since. */
          expectedNotes: Object.fromEntries(accounts.map((a) => [a.id, a.notes])),
        },
      );

      if (!result.ok) {
        throw new ActionError(result.message, result.code, result.fieldErrors);
      }

      return result.data;
    },
    onSuccess: ({ updated }) => {
      toast.success(`Note saved on ${updated} account${updated === 1 ? "" : "s"}`);
      router.refresh();
      onClose();
    },
    onError: (error) => toast.error("Could not save the note", { description: error.userMessage }),
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !save.isPending) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Note for {accounts.length} accounts</DialogTitle>
          <DialogDescription>
            The same account note is written to every selected account, replacing whatever note each
            one has now. Leave it empty to clear their notes.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="bulk-account-note">Internal note</Label>
          <Textarea
            id="bulk-account-note"
            rows={3}
            maxLength={NOTE_MAX}
            autoFocus
            value={draft}
            disabled={save.isPending}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p className="text-caption text-foreground-subtle">
            An account note — not a profile note or a problem note. Never put a password or PIN
            here.
          </p>
        </div>

        {replacing > 0 ? (
          <p role="alert" className="rounded-md bg-warning-subtle p-3 text-caption text-warning">
            {replacing} of these {accounts.length} accounts already have a different note. It will
            be replaced.
          </p>
        ) : null}

        <label className="flex items-start gap-2 text-caption text-foreground">
          <Checkbox
            checked={confirmed}
            onCheckedChange={(checked) => setConfirmed(checked === true)}
            disabled={save.isPending}
            aria-label={`Apply this note to all ${accounts.length} selected accounts`}
          />
          <span>
            Apply this note to all {accounts.length} selected accounts
            {replacing > 0
              ? `, replacing ${replacing} existing note${replacing === 1 ? "" : "s"}`
              : ""}
            .
          </span>
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!confirmed}
            loading={save.isPending}
            loadingLabel="Saving"
          >
            Save note on {accounts.length} accounts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
