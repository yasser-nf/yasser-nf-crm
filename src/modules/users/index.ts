/**
 * Users module — public API.
 *
 * ADR-003 Rule 2: the only entry point. Everything else is internal.
 *
 * The repository is exported because M02 delivers the data layer and no service
 * exists yet to wrap it. When the users service arrives it becomes the public
 * face and the repository export is withdrawn — 02_ARCHITECTURE.md states that
 * only services communicate with the database, so a component must never reach a
 * repository, even through this barrel.
 */
export type { UsersRepository, UserFilter } from "./repositories/users.repository";
export { usersRepository } from "./repositories/users.repository";

export {
  userInsertSchema,
  userSelectSchema,
  userUpdateSchema,
  type UserInsert,
  type UserSelect,
  type UserUpdate,
} from "./validation/user.schema";
