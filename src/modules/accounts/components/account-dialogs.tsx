"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import type { AccountView } from "../services/accounts.service";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog";
import { useCreateAccount, useUpdateAccount } from "../hooks/use-account-mutations";
import { AccountForm } from "./account-form";

/**
 * Create and edit dialogs.
 *
 * 04_UI_GUIDELINES.md: dialogs are for confirmation and focused edits, close on
 * Escape and on outside click, with the primary action on the right. The shadcn
 * Dialog provides that behaviour; these components supply the content.
 *
 * The dialog closes only after the mutation succeeds. Closing on submit would
 * discard the form — and with it whatever the person typed — the moment the
 * server rejected it.
 */

export function CreateAccountDialog() {
  const [open, setOpen] = useState(false);
  const create = useCreateAccount();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) {
          setOpen(next);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="size-4" aria-hidden="true" />
          New account
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Netflix account</DialogTitle>
          <DialogDescription>
            Five profiles are created automatically, numbered 1 to 5.
          </DialogDescription>
        </DialogHeader>

        <AccountForm
          mode="create"
          isSubmitting={create.isPending}
          error={create.error}
          onSubmit={(values) =>
            create.mutate(values, {
              onSuccess: () => setOpen(false),
            })
          }
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

export function EditAccountDialog({
  account,
  open,
  onOpenChange,
}: {
  /* Never the full row: this is a Client Component. See AccountHeader. */
  account: AccountView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateAccount(account.id);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!update.isPending) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit account</DialogTitle>
          <DialogDescription>Every change is recorded in the audit log.</DialogDescription>
        </DialogHeader>

        <AccountForm
          mode="edit"
          account={account}
          isSubmitting={update.isPending}
          error={update.error}
          onSubmit={(values) =>
            update.mutate(values, {
              onSuccess: () => onOpenChange(false),
            })
          }
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
