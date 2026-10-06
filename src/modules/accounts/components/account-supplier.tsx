"use client";

import { Building2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ROUTES } from "@/config/constants";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { cn } from "@/utils/cn";
import { useSetAccountSupplier } from "../hooks/use-account-mutations";
/*
 * Type-only, so it is erased at build time and this Client Component never
 * pulls the suppliers barrel — which re-exports `server-only` services.
 */
import type { SupplierOption } from "@/modules/suppliers";

/**
 * An account's supplier, shown and changed. M10 §7 and §10.
 *
 * "MY ACCOUNT" IS A WORD, NOT A ROW. The model stores NULL (M10 §3), and this
 * is the one place that word is produced for the account screens — so a blank
 * cell never stands in for ownership, which would read as missing data.
 */

/** The sentinel the <select> uses, because a Radix item cannot hold null. */
const MY_ACCOUNT = "__mine__";

export const MY_ACCOUNT_LABEL = "My Account";

/** The supplier line on the account detail page. M10 §10. */
export function AccountSupplierLine({
  supplier,
}: {
  readonly supplier: { readonly id: string; readonly name: string; readonly status: string } | null;
}) {
  return (
    <div className="flex items-center gap-2">
      <Building2 className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
      {supplier === null ? (
        <span className="text-caption text-foreground-muted">{MY_ACCOUNT_LABEL}</span>
      ) : (
        <span className="flex flex-wrap items-center gap-1.5 text-caption">
          <Link
            href={`${ROUTES.SUPPLIERS}/${supplier.id}`}
            className="text-foreground hover:text-primary hover:underline"
          >
            {supplier.name}
          </Link>
          {/*
            An inactive supplier is still named on the accounts it owns — M10
            §23 — and marked, so an operator knows why it is not offered for a
            new assignment.
          */}
          {supplier.status === "inactive" ? (
            <span className="text-foreground-subtle">(inactive)</span>
          ) : null}
        </span>
      )}
    </div>
  );
}

/** The Supplier cell in the accounts list. Text only; the list is dense. */
export function AccountSupplierCell({ supplierName }: { readonly supplierName: string | null }) {
  return (
    <span
      className={cn(
        "text-caption",
        supplierName === null ? "text-foreground-subtle" : "text-foreground",
      )}
    >
      {supplierName ?? MY_ACCOUNT_LABEL}
    </span>
  );
}

/**
 * Changes an account's supplier. M10 §7 and §22.
 *
 * Rendered only for a caller the server said may manage suppliers — and
 * `accountsService.setAccountSupplier` requires the same permission regardless,
 * so this governs what is offered, never what is allowed.
 *
 * An INACTIVE supplier is not offered, because M10 §23 forbids assigning a new
 * account to one. The account's CURRENT supplier is offered even when inactive,
 * so opening this dialog does not silently propose changing it.
 */
export function ChangeAccountSupplierDialog({
  accountId,
  currentSupplierId,
  options,
}: {
  readonly accountId: string;
  readonly currentSupplierId: string | null;
  readonly options: readonly SupplierOption[];
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(currentSupplierId ?? MY_ACCOUNT);
  const assign = useSetAccountSupplier();

  const offered = options.filter(
    (option) => option.status === "active" || option.id === currentSupplierId,
  );

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} className="gap-1.5">
        <Building2 className="size-3.5" aria-hidden="true" />
        Change supplier
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!assign.isPending) {
            setOpen(next);
            if (!next) {
              /* Reopening must not show the last abandoned choice. */
              setChoice(currentSupplierId ?? MY_ACCOUNT);
              assign.reset();
            }
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Account supplier</DialogTitle>
            <DialogDescription>
              Where this account came from. Changing it is recorded in the audit log and does not
              touch the profiles or their history.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <Select value={choice} onValueChange={setChoice}>
              <SelectTrigger className="h-11" aria-label="Supplier">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={MY_ACCOUNT}>{MY_ACCOUNT_LABEL}</SelectItem>
                {offered.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                    {option.status === "inactive" ? " (inactive)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {assign.error ? (
              <p role="alert" className="text-caption text-danger">
                {assign.error instanceof Error ? assign.error.message : "Could not change it."}
              </p>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={assign.isPending}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  assign.mutate(
                    {
                      accountId,
                      /* The sentinel becomes NULL — "My Account" (M10 §3). */
                      supplierId: choice === MY_ACCOUNT ? null : choice,
                    },
                    { onSuccess: () => setOpen(false) },
                  )
                }
                loading={assign.isPending}
                loadingLabel="Saving"
                className="min-w-28"
              >
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
