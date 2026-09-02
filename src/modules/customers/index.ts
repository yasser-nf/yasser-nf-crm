/**
 * Customers module — public API. ADR-003 Rule 2.
 *
 * Owns customer identity, status derivation, subscriptions and history.
 *
 * The repository is still exported because Quick Prepare's find-or-create path
 * predates this module's service. Everything added in M05 goes through the
 * service, which owns authorization and the audit trail.
 */
export {
  customersService,
  type CustomerDetail,
  type CustomerSubscription,
  type FindOrCreateResult,
} from "./services/customers.service";

export {
  CUSTOMER_STATUS_LABELS,
  deriveCustomerStatus,
  expiryUrgency,
  isSubscriptionActive,
  remainingDays,
  type CustomerStatus,
  type ExpiryUrgency,
  type SubscriptionSummary,
} from "./services/customer-status";

export { CustomersFilters, CustomersTable } from "./components/customers-table";
export { ExportCustomersMenu } from "./components/export-customers-menu";
export { parseCustomerFilter } from "./services/customer-filters";
export { CustomerDetailView, CustomerTimeline } from "./components/customer-detail";
export {
  CustomerStatusBadge,
  ExpiryBadge,
  CopyButton,
  WhatsappButton,
} from "./components/customer-shared";

export type {
  CustomersRepository,
  CustomerFilter,
  CustomerSortField,
  CustomerWithStats,
} from "./repositories/customers.repository";
export { customersRepository } from "./repositories/customers.repository";

export {
  customerInsertSchema,
  customerNotesSchema,
  customerSelectSchema,
  customerUpdateSchema,
  type CustomerInsert,
  type CustomerNotesInput,
  type CustomerSelect,
  type CustomerUpdate,
} from "./validation/customer.schema";
