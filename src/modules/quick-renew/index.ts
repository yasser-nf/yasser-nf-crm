/**
 * Quick Renewing module — public API (M09A). ADR-003 Rule 2.
 *
 * Extends the period on a profile a customer already holds. It allocates no
 * stock and decrypts no credential, which is why it is separate from Quick
 * Prepare rather than a branch inside it.
 *
 * The repository is NOT exported: every read and write goes through the
 * service, which owns the permission check and the eligibility rules.
 */
export {
  quickRenewService,
  QUICK_RENEW_SCOPE,
  type AccountProfiles,
  type RenewAccountMatch,
  type RenewProfileSlot,
  type RenewalPreview,
  type RenewalResult,
} from "./services/quick-renew.service";

export {
  MAX_RENEWAL_DAYS,
  MIN_RENEWAL_DAYS,
  RENEWAL_MONTH_OPTIONS,
  applyDuration,
  describeDuration,
  planRenewal,
  renewalBase,
  type RenewalBasis,
  type RenewalDuration,
  type RenewalMonths,
  type RenewalPlan,
} from "./services/renewal-dates";

export {
  accountSearchSchema,
  confirmRenewalSchema,
  renewalDurationSchema,
  renewalPreviewSchema,
  type ConfirmRenewalInput,
  type RenewalPreviewInput,
} from "./validation/renewal.schema";

export { QuickRenewScreen } from "./components/quick-renew-screen";
