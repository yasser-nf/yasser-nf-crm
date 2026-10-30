"use client";

import { Label } from "@/shared/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";

/**
 * Where an account came from, as a pair of form controls (M09B).
 *
 * Shared by the account form, the bulk import dialog and the supplier
 * reassignment dialog, so the three entry points cannot drift into asking the
 * question differently. It renders the controls and reports what was chosen;
 * it validates nothing — `checkOwnership` on the server is the single rule,
 * and the `accounts_supplier_requires_supplied` check is the floor underneath.
 *
 * It lives in `shared/` rather than in the suppliers module for a concrete
 * reason: the accounts module's forms are Client Components, and every module
 * barrel re-exports a `server-only` service, so a client component cannot
 * import one. ADR-003 forbids reaching past a barrel. A presentational
 * component owned by neither module is the one place both may import from.
 *
 * The supplier list arrives as a prop, read on the server by
 * `suppliersService.options`. Nothing here fetches: a Worker is simply handed
 * an empty list, and the server refuses the write regardless.
 */

export type OwnershipValue = "owned" | "supplied" | "unknown";

export interface SupplierOption {
  readonly id: string;
  readonly name: string;
}

export const OWNERSHIP_OPTIONS: readonly {
  readonly value: OwnershipValue;
  readonly label: string;
  readonly hint: string;
}[] = [
  { value: "owned", label: "Our own account", hint: "Bought and held by the business." },
  { value: "supplied", label: "From a supplier", hint: "Obtained from an outside supplier." },
  {
    value: "unknown",
    label: "Not sure yet",
    hint: "It will be listed for triage on the Suppliers page.",
  },
];

export function OwnershipFields({
  ownership,
  supplierId,
  suppliers,
  onOwnershipChange,
  onSupplierChange,
  disabled = false,
  ownershipError,
  supplierError,
  idPrefix = "ownership",
  label = "Where did this come from?",
}: {
  readonly ownership: OwnershipValue;
  readonly supplierId: string | null;
  readonly suppliers: readonly SupplierOption[];
  readonly onOwnershipChange: (value: OwnershipValue) => void;
  readonly onSupplierChange: (value: string | null) => void;
  readonly disabled?: boolean;
  readonly ownershipError?: string | undefined;
  readonly supplierError?: string | undefined;
  readonly idPrefix?: string;
  readonly label?: string;
}) {
  const chosen = OWNERSHIP_OPTIONS.find((option) => option.value === ownership);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label
          htmlFor={`${idPrefix}-ownership`}
          className="text-description font-medium text-foreground"
        >
          {label}
          <span className="text-danger" aria-hidden="true">
            *
          </span>
        </Label>

        <Select
          value={ownership}
          disabled={disabled}
          onValueChange={(value) => {
            const next = value as OwnershipValue;
            onOwnershipChange(next);

            /* An account that is not supplied must not keep a supplier. */
            if (next !== "supplied") {
              onSupplierChange(null);
            }
          }}
        >
          <SelectTrigger id={`${idPrefix}-ownership`} className="h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OWNERSHIP_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {ownershipError ? (
          <p role="alert" className="text-caption text-danger">
            {ownershipError}
          </p>
        ) : chosen ? (
          <p className="text-caption text-foreground-subtle">{chosen.hint}</p>
        ) : null}
      </div>

      {ownership === "supplied" ? (
        <div className="flex flex-col gap-2">
          <Label
            htmlFor={`${idPrefix}-supplier`}
            className="text-description font-medium text-foreground"
          >
            Supplier
          </Label>

          <Select
            value={supplierId ?? ""}
            disabled={disabled || suppliers.length === 0}
            onValueChange={(value) => onSupplierChange(value || null)}
          >
            <SelectTrigger id={`${idPrefix}-supplier`} className="h-11 w-full">
              <SelectValue placeholder="Choose a supplier" />
            </SelectTrigger>
            <SelectContent>
              {suppliers.map((supplier) => (
                <SelectItem key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {supplierError ? (
            <p role="alert" className="text-caption text-danger">
              {supplierError}
            </p>
          ) : suppliers.length === 0 ? (
            <p className="text-caption text-warning">
              There are no suppliers yet. Add one on the Suppliers page first.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
