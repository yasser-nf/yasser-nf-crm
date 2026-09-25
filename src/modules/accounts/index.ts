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
  /*
   * The credential-dropping projections. Exported so every module that sends an
   * account or a profile to a browser strips it the same way, in one function.
   */
  toAccountView,
  toProfileView,
  type AccountDetail,
  type AccountListRow,
  type AccountView,
  type AllocationBlockedReason,
  type AllocationContext,
  type AllocationValidity,
  type BulkCreateResult,
  type ProfileAllocation,
  type ProfileAllocationWithCustomer,
  type ProfileIndicator,
  type ProfileView,
} from "./services/accounts.service";
export { profilesService } from "./services/profiles.service";

/*
 * Account validity is pure and carries no `server-only`, so it is safe for a
 * unit test or another module to import through this barrel. The service beside
 * it is not — which is why tests of the allocation engine still reach that file
 * directly rather than coming through here.
 */
export {
  accountCanAllocate,
  accountEffectiveStatus,
  accountRemainingDays,
  canCoverDuration,
  isAccountExpired,
  isAllocationExpired,
  isProfileFree,
  isSellableSlot,
  profileCellState,
  remainingCustomerDays,
  resolveValidity,
  type AccountEffectiveStatus,
  type ProfileCellState,
} from "./services/account-validity";

export {
  profileCustomerLabel,
  resolveProfileCustomer,
  PROFILE_CUSTOMER_EMPTY_LABEL,
  PROFILE_CUSTOMER_MISSING_LABEL,
  type ProfileCustomerLink,
  type ProfileCustomerSummary,
} from "./services/profile-customer";

export {
  parseBulkAccounts,
  previewBulkAccounts,
  BULK_COLUMNS,
  BULK_TEMPLATE,
  type BulkParseResult,
  type BulkPreview,
  type BulkPreviewRow,
  type BulkRowError,
} from "./services/bulk-accounts.service";

/* Components consumed by app/ page composition. */
export { AccountsTable } from "./components/accounts-table";
export { parseAccountFilter } from "./services/account-filters";
export { AccountsFilters } from "./components/accounts-filters";
export { ExportAccountsMenu } from "./components/export-accounts-menu";
export { AccountSelectionProvider } from "./components/account-selection-context";
export { AccountHeader } from "./components/account-header";
export { AccountTimeline } from "./components/account-timeline";
export { ProfileCard } from "./components/profile-card";
export { ProfileIndicators, ProfileIndicatorLegend } from "./components/profile-indicators";
export { CopyCredentials } from "./components/copy-credentials";
export { CreateAccountDialog, EditAccountDialog } from "./components/account-dialogs";
export { BulkAccountsDialog } from "./components/bulk-accounts-dialog";
export {
  AccountStatusBadge,
  ProfileStatusBadge,
  accountBadgeStyle,
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
  changePasswordSchema,
  profileSlotsSchema,
  MAX_ACCOUNT_DURATION_DAYS,
  MAX_PROFILE_SLOTS,
  MIN_PROFILE_SLOTS,
  type AccountInsert,
  type AccountSelect,
  type AccountUpdate,
  type ChangePasswordInput,
  type ProfileSlotsInput,
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
