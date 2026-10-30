/**
 * Where an account came from, as a list filter (M09B).
 *
 * Shared by the Accounts list, the Problems list and the account CSV export,
 * so "accounts from Karim" means the same rows on every screen. It lives in
 * `lib/` rather than in a module because both the accounts and the problems
 * repositories filter on it, and ADR-003 forbids either importing the other.
 *
 * Pure and client-safe: the filter controls build their options from it too,
 * so the browser and the server cannot disagree about what a value means.
 *
 * The URL form is a single `source` parameter:
 *
 *   owned               our own accounts
 *   supplied            from any supplier, recorded or not
 *   unassigned          from a supplier, supplier not recorded yet
 *   unknown             provenance not decided
 *   supplier:<uuid>     from one named supplier
 *
 * Anything else is ignored rather than rejected — a query string is user
 * input, and a stale bookmark should show the unfiltered list, not an error.
 */

export const ACCOUNT_SOURCE_PARAM = "source";

export type AccountSource =
  | { readonly kind: "owned" }
  | { readonly kind: "supplied" }
  | { readonly kind: "unassigned" }
  | { readonly kind: "unknown" }
  | { readonly kind: "supplier"; readonly supplierId: string };

const SUPPLIER_PREFIX = "supplier:";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAccountSource(raw: string | null | undefined): AccountSource | undefined {
  switch (raw) {
    case "owned":
    case "supplied":
    case "unassigned":
    case "unknown":
      return { kind: raw };
  }

  if (raw?.startsWith(SUPPLIER_PREFIX)) {
    const supplierId = raw.slice(SUPPLIER_PREFIX.length);

    /* Checked here so a malformed id never reaches a uuid comparison in SQL. */
    return UUID.test(supplierId) ? { kind: "supplier", supplierId } : undefined;
  }

  return undefined;
}

/** The URL value for one supplier. The only place the prefix is written. */
export function supplierSourceValue(supplierId: string): string {
  return `${SUPPLIER_PREFIX}${supplierId}`;
}

/**
 * The choices a filter control offers, in the order it shows them.
 *
 * The broad answers first, then one entry per live supplier. "Any supplier"
 * includes accounts awaiting triage; "Supplier not recorded" is those alone.
 */
export function accountSourceOptions(
  suppliers: readonly { readonly id: string; readonly name: string }[],
): readonly { readonly value: string; readonly label: string }[] {
  return [
    { value: "owned", label: "Our own accounts" },
    { value: "supplied", label: "From any supplier" },
    { value: "unassigned", label: "Supplier not recorded" },
    { value: "unknown", label: "Source not decided" },
    ...suppliers.map((supplier) => ({
      value: supplierSourceValue(supplier.id),
      label: `Supplier: ${supplier.name}`,
    })),
  ];
}
