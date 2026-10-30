"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircle, Plus, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { ActionError } from "@/lib/errors";
import { FormField } from "@/shared/forms/form-field";
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
import {
  useCreateSupplier,
  useDeleteSupplier,
  useUpdateSupplier,
} from "../hooks/use-supplier-mutations";
import {
  SUPPLIER_CONTACT_MAX,
  SUPPLIER_NAME_MAX,
  SUPPLIER_NOTES_MAX,
} from "../validation/supplier.schema";
import type { SupplierListItem } from "../services/suppliers.service";

/**
 * Add, edit and delete a supplier (M09B).
 *
 * The form asks for a name and nothing else, because an operator who knows
 * only "Karim on WhatsApp" must still be able to record that rather than
 * recording nothing. Contact and notes are free text for exactly that reason.
 *
 * The client schema here is a mirror of `supplier.schema.ts`; the service
 * revalidates, so this one exists to answer before a round trip, never to be
 * the thing that decides.
 */

const supplierFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter the supplier's name")
    .max(SUPPLIER_NAME_MAX, `A name is limited to ${SUPPLIER_NAME_MAX} characters`),
  contact: z.string().trim().max(SUPPLIER_CONTACT_MAX).optional(),
  notes: z.string().trim().max(SUPPLIER_NOTES_MAX).optional(),
});

type SupplierFormValues = z.infer<typeof supplierFormSchema>;

function SupplierForm({
  supplier,
  isSubmitting,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  readonly supplier?: SupplierListItem | undefined;
  readonly isSubmitting: boolean;
  readonly error?: unknown;
  readonly submitLabel: string;
  readonly onSubmit: (values: Record<string, unknown>) => void;
  readonly onCancel: () => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SupplierFormValues>({
    resolver: zodResolver(supplierFormSchema),
    mode: "onTouched",
    defaultValues: {
      name: supplier?.name ?? "",
      contact: supplier?.contact ?? "",
      notes: supplier?.notes ?? "",
    },
  });

  const serverFieldErrors = error instanceof ActionError ? (error.fieldErrors ?? {}) : {};

  const fieldError = (name: keyof SupplierFormValues): string | undefined =>
    errors[name]?.message ?? serverFieldErrors[name];

  const submit = handleSubmit((values) => {
    /*
     * A cleared box is sent as null on edit, so the stored value is removed
     * rather than left behind; on create the service simply omits an empty one.
     */
    onSubmit({
      name: values.name,
      contact: values.contact === "" ? (supplier ? null : undefined) : values.contact,
      notes: values.notes === "" ? (supplier ? null : undefined) : values.notes,
    });
  });

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <FormField
        label="Supplier name"
        placeholder="Karim — Telegram"
        autoComplete="off"
        disabled={isSubmitting}
        error={fieldError("name")}
        required
        {...register("name")}
      />

      <FormField
        label="Contact"
        placeholder="Phone, Telegram handle, email — however you reach them"
        autoComplete="off"
        disabled={isSubmitting}
        error={fieldError("contact")}
        hint="Optional."
        {...register("contact")}
      />

      <div className="flex flex-col gap-2">
        <Label htmlFor="supplier-notes" className="text-description font-medium text-foreground">
          Notes
        </Label>
        <Textarea
          id="supplier-notes"
          rows={3}
          placeholder="Prices, delivery times, anything worth remembering"
          disabled={isSubmitting}
          className="bg-background-secondary"
          {...register("notes")}
        />
        {fieldError("notes") ? (
          <p role="alert" className="text-caption text-danger">
            {fieldError("notes")}
          </p>
        ) : null}
      </div>

      <div className="mt-2 flex items-center justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting} className="min-w-32">
          {isSubmitting ? (
            <>
              <LoaderCircle className="animate-spin" aria-hidden="true" />
              Saving
            </>
          ) : (
            submitLabel
          )}
        </Button>
      </div>
    </form>
  );
}

export function CreateSupplierDialog() {
  const [open, setOpen] = useState(false);
  const create = useCreateSupplier();

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
          New supplier
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New supplier</DialogTitle>
          <DialogDescription>
            Only a name is required. You can assign accounts to them straight afterwards.
          </DialogDescription>
        </DialogHeader>

        {/* Remounted per opening, so the next one starts from an empty form. */}
        {open ? (
          <SupplierForm
            isSubmitting={create.isPending}
            error={create.error}
            submitLabel="Add supplier"
            onSubmit={(values) => create.mutate(values, { onSuccess: () => setOpen(false) })}
            onCancel={() => setOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function EditSupplierDialog({
  supplier,
  open,
  onOpenChange,
}: {
  readonly supplier: SupplierListItem;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateSupplier(supplier.id);

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
          <DialogTitle>Edit supplier</DialogTitle>
          <DialogDescription>Every change is recorded in the audit log.</DialogDescription>
        </DialogHeader>

        <SupplierForm
          supplier={supplier}
          isSubmitting={update.isPending}
          error={update.error}
          submitLabel="Save changes"
          onSubmit={(values) => update.mutate(values, { onSuccess: () => onOpenChange(false) })}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Archive, or delete.
 *
 * Archiving hides a supplier from the pickers while every account keeps its
 * provenance, which is what an operator usually means by "we stopped using
 * them". Deleting is refused while accounts still name the supplier — the
 * foreign key is ON DELETE RESTRICT and the service checks first — so the
 * button offers it only when the count is already zero.
 */
export function SupplierDangerActions({ supplier }: { readonly supplier: SupplierListItem }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const update = useUpdateSupplier(supplier.id);
  const remove = useDeleteSupplier(supplier.id);
  const isArchived = supplier.archivedAt !== null;

  return (
    <>
      <Button
        variant="outline"
        disabled={update.isPending}
        onClick={() => update.mutate({ archived: !isArchived })}
      >
        {isArchived ? "Unarchive" : "Archive"}
      </Button>

      <Button
        variant="outline"
        className="text-danger"
        disabled={remove.isPending}
        onClick={() => setConfirmingDelete(true)}
      >
        Delete
      </Button>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-danger" aria-hidden="true" />
              Delete this supplier?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {supplier.accountCount > 0
                ? `${supplier.accountCount} account${supplier.accountCount === 1 ? "" : "s"} still name this supplier. ` +
                  "Reassign them first, or archive the supplier instead — deleting will be refused."
                : "The record is kept and marked deleted, so the audit history still resolves the name. It disappears from every list."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => remove.mutate()}
              disabled={remove.isPending || supplier.accountCount > 0}
            >
              Delete supplier
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
