/**
 * Suppliers module — public API. ADR-003 Rule 2. M10.
 *
 * Owns where stock comes from: the supplier records, their metrics, and the
 * rule for whether a supplier may receive an account.
 *
 * A SUPPLIER BELONGS TO AN ACCOUNT, NEVER TO A PROFILE. The relationship is
 * `accounts.supplier_id` and nothing else; a profile reaches its supplier
 * through its account. See lib/drizzle/schema/suppliers.ts.
 *
 * ONE DIRECTION. This module knows nothing about accounts as a module — it
 * reads the shared `accounts` table for its metrics, which ADR-005 Decision 5
 * permits, but imports no accounts code. `accountsService` imports THIS barrel,
 * so the dependency has one direction and `madge --circular` stays clean.
 *
 * The repository is not exported. Its metric query composes predicates that are
 * only correct together, and a caller assembling its own counts would be the
 * second definition of "problem account" that M10 §16 forbids.
 */
export {
  suppliersService,
  /*
   * Exported for `accountsService`, which assigns a supplier at account
   * creation. The SAME function, so the two assignment points cannot drift on
   * who is allowed to do it.
   */
  assertMayAssignSupplier,
  type SupplierDetail,
  type SupplierListEntry,
  type SupplierOption,
  type SupplierView,
} from "./services/suppliers.service";

export type {
  OwnershipCounts,
  SupplierMetrics,
  SupplierWithMetrics,
} from "./repositories/suppliers.repository";

/*
 * Pure, free of `server-only`, and safe for a unit test or another module to
 * import through this barrel.
 */
export {
  cleanSupplierName,
  isSameSupplierName,
  isValidSupplierName,
  normalizeSupplierName,
  MAX_SUPPLIER_NAME_LENGTH,
  MAX_SUPPLIER_NOTES_LENGTH,
  type NormalizedSupplierName,
} from "./services/supplier-name";

export {
  acceptsNewAccounts,
  deriveSupplierStatus,
  SUPPLIER_STATUS_LABELS,
  type SupplierStatus,
} from "./services/supplier-status";

export {
  accountSupplierSchema,
  supplierCreateSchema,
  supplierFilterSchema,
  supplierIdSchema,
  supplierUpdateSchema,
  type AccountSupplierInput,
  type SupplierCreateInput,
  type SupplierFilterInput,
  type SupplierUpdateInput,
} from "./validation/supplier.schema";

/* Components consumed by app/ page composition and by the accounts screens. */
export {
  CreateSupplierDialog,
  EditSupplierDialog,
  SupplierActiveToggle,
} from "./components/supplier-dialogs";
export {
  SuppliersFilters,
  SuppliersTable,
  SupplierStatusBadge,
} from "./components/suppliers-table";
export { SupplierForm } from "./components/supplier-form";
