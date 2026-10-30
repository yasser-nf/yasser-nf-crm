/**
 * Suppliers module — public API (M09B). ADR-003 Rule 2.
 *
 * Who the business buys accounts from, and which accounts came from whom.
 * Every non-owned account names a supplier, or is listed for triage until it
 * does.
 *
 * The repository is NOT exported. Every read and write goes through the
 * service, which owns the permission check — suppliers and their contacts are
 * Super Admin data, and a Worker must not reach them by importing a query.
 */
export {
  suppliersService,
  type SupplierAccountRow,
  type SupplierDetail,
  type SupplierListItem,
  type SuppliersOverview,
} from "./services/suppliers.service";

export type { SupplierFilter, SupplierMetrics } from "./repositories/suppliers.repository";

export {
  accountOwnershipSchema,
  assignSupplierSchema,
  createSupplierSchema,
  supplierNameSchema,
  updateSupplierSchema,
  SUPPLIER_CONTACT_MAX,
  SUPPLIER_NAME_MAX,
  SUPPLIER_NOTES_MAX,
  type AccountOwnershipInput,
  type AssignSupplierInput,
  type CreateSupplierInput,
  type UpdateSupplierInput,
} from "./validation/supplier.schema";

export { AssignSupplierButton, AssignSupplierDialog } from "./components/assign-supplier-dialog";
export { CreateSupplierDialog, SupplierDangerActions } from "./components/supplier-dialogs";
export { SupplierAccountsTable } from "./components/supplier-accounts-table";
export { SupplierMetricsStrip } from "./components/supplier-metrics";
export { SuppliersFilters } from "./components/suppliers-filters";
export { SuppliersTable } from "./components/suppliers-table";
export { UnassignedAccounts } from "./components/unassigned-accounts";
