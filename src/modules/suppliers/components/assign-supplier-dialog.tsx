"use client";

import { LoaderCircle } from "lucide-react";
import { useState } from "react";

import { ActionError } from "@/lib/errors";
import {
  OwnershipFields,
  type OwnershipValue,
  type SupplierOption,
} from "@/shared/forms/ownership-fields";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { useAssignSupplier } from "../hooks/use-supplier-mutations";

/**
 * Sets where one existing account came from (M09B).
 *
 * The only place an account moves between suppliers, so it is also the triage
 * tool: a supplied account with no supplier recorded is listed on the Suppliers
 * page and fixed from here.
 *
 * Unlike account creation, this dialog permits "supplied, supplier not chosen".
 * That combination is what the triage list is made of — refusing to save it
 * would mean an operator who knows an account came from outside but not from
 * whom could record neither fact.
 */
export function AssignSupplierDialog({
  account,
  suppliers,
  open,
  onOpenChange,
}: {
  readonly account: {
    readonly id: string;
    readonly email: string;
    readonly ownership: OwnershipValue;
    readonly supplierId: string | null;
  };
  readonly suppliers: readonly SupplierOption[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const assign = useAssignSupplier();
  const [ownership, setOwnership] = useState<OwnershipValue>(account.ownership);
  const [supplierId, setSupplierId] = useState<string | null>(account.supplierId);

  const fieldErrors = assign.error instanceof ActionError ? (assign.error.fieldErrors ?? {}) : {};

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!assign.isPending) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Where did this account come from?</DialogTitle>
          <DialogDescription className="font-mono">{account.email}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <OwnershipFields
            idPrefix={`assign-${account.id}`}
            ownership={ownership}
            supplierId={supplierId}
            suppliers={suppliers}
            onOwnershipChange={setOwnership}
            onSupplierChange={setSupplierId}
            disabled={assign.isPending}
            ownershipError={fieldErrors["ownership"]}
            supplierError={fieldErrors["supplierId"]}
          />

          {ownership === "supplied" && supplierId === null ? (
            <p className="rounded-md border border-warning/30 bg-warning-subtle p-3 text-caption text-warning">
              Saved without a supplier, this account stays on the triage list below until one is
              chosen.
            </p>
          ) : null}

          <div className="mt-2 flex items-center justify-end gap-3">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={assign.isPending}>
              Cancel
            </Button>
            <Button
              className="min-w-28"
              disabled={assign.isPending}
              onClick={() =>
                assign.mutate(
                  {
                    accountId: account.id,
                    /*
                     * Shaped as the discriminated union the service parses:
                     * only a supplied account carries the supplier key at all.
                     */
                    ownership: ownership === "supplied" ? { ownership, supplierId } : { ownership },
                  },
                  { onSuccess: () => onOpenChange(false) },
                )
              }
            >
              {assign.isPending ? (
                <>
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                  Saving
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A row's "Set supplier" button, with the dialog it opens. */
export function AssignSupplierButton({
  account,
  suppliers,
  label = "Set supplier",
}: {
  readonly account: {
    readonly id: string;
    readonly email: string;
    readonly ownership: OwnershipValue;
    readonly supplierId: string | null;
  };
  readonly suppliers: readonly SupplierOption[];
  readonly label?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      {/* Remounted per opening, so it always starts from the row's saved values. */}
      {open ? (
        <AssignSupplierDialog
          account={account}
          suppliers={suppliers}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}
