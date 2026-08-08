/**
 * Customers module — public API. ADR-003 Rule 2.
 *
 * The repository is exported because M02 delivers the data layer and no service
 * exists yet. It is withdrawn once the customers service arrives — components
 * must reach a service, never a repository.
 */
export type { CustomersRepository, CustomerFilter } from "./repositories/customers.repository";
export { customersRepository } from "./repositories/customers.repository";

export {
  customerInsertSchema,
  customerSelectSchema,
  customerUpdateSchema,
  type CustomerInsert,
  type CustomerSelect,
  type CustomerUpdate,
} from "./validation/customer.schema";
