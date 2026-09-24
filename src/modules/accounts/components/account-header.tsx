"use client";

import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  Eye,
  EyeOff,
  Pencil,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type { AccountView } from "../services/accounts.service";
import { Button } from "@/shared/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import {
  useArchiveAccount,
  useDeleteAccount,
  useRestoreAccount,
  useRevealPassword,
} from "../hooks/use-account-mutations";
import { AccountNoteCell } from "./account-note-cell";
import { EditAccountDialog } from "./account-dialogs";
import { CopyCredentials } from "./copy-credentials";
import { AccountStatusBadge } from "./status-badge";

/**
 * Account detail header.
 *
 * Carries the account's identity, its password control, and the lifecycle
 * actions: edit, archive, restore, delete.
 *
 * 04_UI_GUIDELINES.md: destructive actions use a dialog, never a drawer, and a
 * dialog has one primary action. Archive and delete each get their own
 * confirmation because they are not the same act — one is reversible.
 */

function formatDateTime(value: Date | string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * `AccountView`, not `AccountRow`.
 *
 * This is a Client Component, so whatever it accepts is serialized into the RSC
 * payload and lands in the page source. `AccountView` has no
 * `passwordEncrypted`, which makes shipping the ciphertext to a browser a type
 * error rather than an oversight.
 */
export function AccountHeader({
  account,
  remainingValidityDays,
  hasActiveProblem = false,
  activeProblemTypes = [],
}: {
  account: AccountView;
  /**
   * True when a problem in a blocking status is open against this account.
   *
   * The problems list sits further down this page, but the badge is what a
   * worker reads first — and it cannot say "Healthy" while that list is
   * non-empty. Same rule and same override as the accounts list. M13 §7.
   */
  hasActiveProblem?: boolean;
  /** The types of those problems, so a single kind is named on the badge. */
  activeProblemTypes?: readonly string[];
  /**
   * Computed by the service through `accountRemainingDays`, never here.
   *
   * M13 §3 forbids new date arithmetic in the UI, and this component has no
   * clock it could trust anyway — a value derived in the browser would drift
   * from the one the allocation engine used on the server.
   */
  remainingValidityDays: number | null;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const archive = useArchiveAccount(account.id);
  const restore = useRestoreAccount(account.id);
  const remove = useDeleteAccount(account.id);

  const isArchived = account.status === "archived";

  return (
    <section className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-page-title break-all text-foreground">{account.email}</h1>
            <AccountStatusBadge
              status={account.status}
              hasActiveProblem={hasActiveProblem}
              activeProblemTypes={activeProblemTypes}
            />
          </div>

          <p className="text-caption text-foreground-subtle">
            Created {formatDateTime(account.createdAt)} · Updated{" "}
            {formatDateTime(account.updatedAt)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setIsEditing(true)} className="gap-2">
            <Pencil className="size-4" aria-hidden="true" />
            Edit
          </Button>

          {isArchived ? (
            <Button
              variant="outline"
              onClick={() => restore.mutate()}
              loading={restore.isPending}
              loadingLabel="Restoring"
              className="gap-2"
            >
              <ArchiveRestore className="size-4" aria-hidden="true" />
              Restore
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => setConfirmingArchive(true)}
              /*
               * The confirmation dialog closes the moment it is confirmed, so a
               * spinner on its action button would never be seen. The trigger
               * outlives the dialog and is where the wait is actually visible.
               */
              loading={archive.isPending}
              loadingLabel="Archiving"
              className="gap-2"
            >
              <Archive className="size-4" aria-hidden="true" />
              Archive
            </Button>
          )}

          <Button
            variant="ghost"
            onClick={() => setConfirmingDelete(true)}
            loading={remove.isPending}
            loadingLabel="Deleting"
            className="gap-2 text-danger hover:bg-danger-subtle hover:text-danger"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Country">
          <span className="text-foreground">{account.country ?? "—"}</span>
        </Field>

        <div className="sm:col-span-2">
          <PasswordField accountId={account.id} />
        </div>
      </div>

      {/* Inventory. M13 §3. */}
      <div className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Sellable profiles">
          <span className="text-foreground">
            {account.profileSlots} of 5
            <span className="ml-2 text-caption text-foreground-subtle">
              {account.profileSlots === 5
                ? "all sellable"
                : `${5 - account.profileSlots} not for sale`}
            </span>
          </span>
        </Field>

        <Field label="Valid from">
          <span className="text-foreground">{account.validFrom ?? "—"}</span>
        </Field>

        <Field label="Valid until">
          <span className="text-foreground">
            {account.validUntil ?? <span className="text-foreground-muted">Open-ended</span>}
          </span>
        </Field>

        <Field label="Remaining validity">
          <RemainingValidity remainingDays={remainingValidityDays} />
        </Field>
      </div>

      {/* M13 §2 and §4: the same three controls the accounts list offers. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-5">
        <span className="text-caption text-foreground-subtle">Credentials</span>
        <CopyCredentials accountId={account.id} email={account.email} variant="full" />
      </div>

      {/*
        The same component the accounts list renders, in its full-text form.
        One component and one column, so the note shown here and the note shown
        in the list cannot disagree — and it is rendered unconditionally now,
        because an account with no note still needs somewhere to add one.
      */}
      <Field label="Notes">
        <AccountNoteCell
          accountId={account.id}
          accountEmail={account.email}
          note={account.notes}
          variant="full"
          className="items-start"
        />
      </Field>

      <EditAccountDialog account={account} open={isEditing} onOpenChange={setIsEditing} />

      <AlertDialog open={confirmingArchive} onOpenChange={setConfirmingArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this account?</AlertDialogTitle>
            <AlertDialogDescription>
              All five profiles stop being available for allocation immediately. Nothing is deleted,
              and you can restore it at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => archive.mutate()} disabled={archive.isPending}>
              Archive account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-danger" aria-hidden="true" />
              Delete this account?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The record is kept and marked deleted — nothing is erased, and the audit history
              survives. It disappears from every list and cannot be restored from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="bg-danger text-white hover:bg-danger/90"
            >
              Delete account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/**
 * Remaining account validity, in words.
 *
 * Open-ended is stated rather than shown as a dash, because "no boundary" and
 * "no data" look identical otherwise and mean opposite things for allocation.
 */
function RemainingValidity({ remainingDays }: { remainingDays: number | null }) {
  if (remainingDays === null) {
    return <span className="text-foreground-muted">Open-ended</span>;
  }

  if (remainingDays < 0) {
    return (
      <span className="text-danger">
        Expired {Math.abs(remainingDays)} day{Math.abs(remainingDays) === 1 ? "" : "s"} ago
      </span>
    );
  }

  if (remainingDays === 0) {
    return <span className="text-warning">Expires today</span>;
  }

  return (
    <span className={remainingDays < 15 ? "text-warning" : "text-foreground"}>
      {remainingDays} day{remainingDays === 1 ? "" : "s"} left
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-foreground-subtle">{label}</span>
      {children}
    </div>
  );
}

/**
 * Password, revealed only on request.
 *
 * ADR-006 Decision 4: the plaintext is never part of the page payload. It is
 * fetched by a deliberate click, which is also what makes the reveal auditable —
 * an implicit reveal on page load could not be attributed to an intention.
 *
 * The value is held in component state and disappears on navigation. It is never
 * written to a query cache, because a cache would keep it alive well past the
 * moment it was needed.
 */
function PasswordField({ accountId }: { accountId: string }) {
  const [password, setPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const reveal = useRevealPassword(accountId);

  async function copy() {
    if (!password) {
      return;
    }

    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy", { description: "Your browser blocked clipboard access." });
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-foreground-subtle">Password</span>

      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-background-secondary px-3 py-2 font-mono text-description text-foreground">
          {password ?? "••••••••••••"}
        </code>

        {password === null ? (
          <Button
            variant="outline"
            size="icon"
            aria-label="Reveal password"
            loading={reveal.isPending}
            onClick={() => reveal.mutate(undefined, { onSuccess: setPassword })}
          >
            <Eye aria-hidden="true" />
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              size="icon"
              aria-label={copied ? "Copied" : "Copy password"}
              onClick={copy}
            >
              {copied ? (
                <Check className="text-success" aria-hidden="true" />
              ) : (
                <Copy aria-hidden="true" />
              )}
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Hide password"
              onClick={() => setPassword(null)}
            >
              <EyeOff aria-hidden="true" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
