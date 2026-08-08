/**
 * Accounts module — public API. ADR-003 Rule 2.
 *
 * Owns the account aggregate: accounts, their five profiles, and profile
 * history. Profiles are not a separate module because a profile has no meaning
 * outside its account, and splitting them would put the five-profile rule on the
 * wrong side of a module boundary.
 *
 * Repositories are exported because M02 delivers the data layer and no service
 * exists yet. They are withdrawn once services arrive.
 */
export type { AccountsRepository, AccountFilter } from "./repositories/accounts.repository";
export { accountsRepository } from "./repositories/accounts.repository";

export type { ProfilesRepository, ProfileFilter } from "./repositories/profiles.repository";
export { profilesRepository } from "./repositories/profiles.repository";

export {
  accountInsertSchema,
  accountSelectSchema,
  accountUpdateSchema,
  type AccountInsert,
  type AccountSelect,
  type AccountUpdate,
} from "./validation/account.schema";

export {
  PROFILES_PER_ACCOUNT,
  PROFILE_NUMBERS,
  profileEventInsertSchema,
  profileEventSelectSchema,
  profileInsertSchema,
  profileSelectSchema,
  profileUpdateSchema,
  type ProfileEventInsert,
  type ProfileEventSelect,
  type ProfileInsert,
  type ProfileSelect,
  type ProfileUpdate,
} from "./validation/profile.schema";
