/**
 * Accounts module — public API. ADR-003 Rule 2.
 *
 * Owns the account aggregate: accounts, their five profiles, and profile
 * history. Profiles are not a separate module because a profile has no meaning
 * outside its account, and splitting them would put the five-profile rule on the
 * wrong side of a module boundary.
 */

/* Services — the only sanctioned way in for pages and other modules. */
export {
  accountsService,
  evaluateAllocation,
  type AccountDetail,
  type ProfileAllocation,
} from "./services/accounts.service";
export { profilesService } from "./services/profiles.service";

/* Components consumed by app/ page composition. */
export { AccountsTable } from "./components/accounts-table";
export { AccountsFilters } from "./components/accounts-filters";
export { AccountHeader } from "./components/account-header";
export { AccountTimeline } from "./components/account-timeline";
export { ProfileCard } from "./components/profile-card";
export { CreateAccountDialog, EditAccountDialog } from "./components/account-dialogs";
export {
  AccountStatusBadge,
  ProfileStatusBadge,
  accountStatusLabel,
  ACCOUNT_STATUS_OPTIONS,
} from "./components/status-badge";

/*
 * Repositories are still exported for the modules that have no service yet.
 * Accounts and profiles now have one, so pages must use the service — a
 * component reaching a repository would skip authorization and the audit trail.
 */
export type {
  AccountsRepository,
  AccountFilter,
  AccountSortField,
  AccountWithCounts,
} from "./repositories/accounts.repository";
export type { ProfilesRepository, ProfileFilter } from "./repositories/profiles.repository";

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
  profileEditSchema,
  profileEventInsertSchema,
  profileEventSelectSchema,
  profileInsertSchema,
  profileSelectSchema,
  profileUpdateSchema,
  type ProfileEdit,
  type ProfileEventInsert,
  type ProfileEventSelect,
  type ProfileInsert,
  type ProfileSelect,
  type ProfileUpdate,
} from "./validation/profile.schema";
