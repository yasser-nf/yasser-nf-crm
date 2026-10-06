"use client";

import { Pencil, Plus, Power, PowerOff } from "lucide-react";
import { useState } from "react";

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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog";
import { useCreateSupplier, useSetSupplierActive, useUpdateSupplier } from "../hooks/use-suppliers";
import { SupplierForm } from "./supplier-form";

/**
 * Supplier dialogs. M10 §6 and §28.
 *
 * Each one closes only after its mutation succeeds. Closing on submit would
 * discard what was typed the moment the server rejected it — the rule
 * `account-dialogs.tsx` already states.
 *
 * Every dialog here is rendered only for a caller the server told us may manage
 * suppliers. That is what to OFFER; `suppliersService` decides what is allowed,
 * and refuses the action regardless of whether the button was on screen.
 */

export function CreateSupplierDialog() {
  const [open, setOpen] = useState(false);
  const create = useCreateSupplier();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) {
          setOpen(next);
          if (!next) create.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="size-4" aria-hidden="true" />
          New supplier
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New supplier</DialogTitle>
          <DialogDescription>
            Accounts bought from this supplier can be assigned to it afterwards.
          </DialogDescription>
        </DialogHeader>

        <SupplierForm
          mode="create"
          isSubmitting={create.isPending}
          error={create.error}
          onSubmit={(values) => create.mutate(values, { onSuccess: () => setOpen(false) })}
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

export function EditSupplierDialog({
  supplierId,
  name,
  notes,
}: {
  readonly supplierId: string;
  readonly name: string;
  readonly notes: string | null;
}) {
  const [open, setOpen] = useState(false);
  const update = useUpdateSupplier(supplierId);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!update.isPending) {
          setOpen(next);
          if (!next) update.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          <Pencil className="size-3.5" aria-hidden="true" />
          Edit
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit supplier</DialogTitle>
          <DialogDescription>Every change is recorded in the audit log.</DialogDescription>
        </DialogHeader>

        <SupplierForm
          mode="edit"
          defaultName={name}
          defaultNotes={notes ?? ""}
          isSubmitting={update.isPending}
          error={update.error}
          onSubmit={(values) => update.mutate(values, { onSuccess: () => setOpen(false) })}
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Deactivate or reactivate. M10 §23.
 *
 * A confirmation, because the consequence is not obvious from the button: the
 * accounts stay. The dialog says so rather than leaving an operator to guess
 * whether they are about to orphan fifty accounts.
 *
 * There is no Delete. M10 §6 and §24 prefer deactivation, the foreign key is
 * RESTRICT, and the service exposes no delete at all — so this dialog is the
 * whole of a supplier's lifecycle.
 */
export function SupplierActiveToggle({
  supplierId,
  name,
  active,
  accountCount,
}: {
  readonly supplierId: string;
  readonly name: string;
  readonly active: boolean;
  readonly accountCount: number;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useSetSupplierActive(supplierId);

  return (
    <AlertDialog open={open} onOpenChange={toggle.isPending ? undefined : setOpen}>
      <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        {active ? (
          <PowerOff className="size-3.5" aria-hidden="true" />
        ) : (
          <Power className="size-3.5" aria-hidden="true" />
        )}
        {active ? "Deactivate" : "Reactivate"}
      </Button>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {active ? `Deactivate ${name}?` : `Reactivate ${name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {active ? (
              <>
                {accountCount === 0
                  ? "No account is assigned to this supplier yet."
                  : `${accountCount} account${accountCount === 1 ? "" : "s"} stay assigned to this supplier and keep showing its name.`}{" "}
                No new account can be assigned to it until it is reactivated. Nothing is deleted.
              </>
            ) : (
              "New accounts can be assigned to this supplier again."
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={toggle.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              /* Keep the dialog open until the mutation answers. */
              event.preventDefault();
              toggle.mutate(!active, { onSuccess: () => setOpen(false) });
            }}
            disabled={toggle.isPending}
          >
            {active ? "Deactivate" : "Reactivate"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
