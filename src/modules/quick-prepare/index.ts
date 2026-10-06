/**
 * Quick Prepare module — public API. ADR-003 Rule 2.
 *
 * The allocation engine. Owns selection, the sale transaction and replacement.
 *
 * The repository is deliberately not exported. Its locking read is only correct
 * inside this module's transaction, and handing it to a caller that does not
 * open one would produce a lock-free "check then allocate" race.
 */
export {
  quickPrepareService,
  /* M08 jobs: receipt scopes, for a job type that runs one of these operations. */
  QUICK_PREPARE_SCOPE,
  QUICK_REPLACE_SCOPE,
} from "./services/quick-prepare.service";
export type {
  PreparationPreview,
  PreparationResult,
  PreparedAccount,
  PreparedProfile,
} from "./services/quick-prepare.service";

/* Quick Replace. The preview writes nothing; the commit is on quickPrepareService. */
export { quickReplaceService } from "./services/quick-replace.service";
export type {
  AccountProfileSlot,
  ReplacementCandidate,
  ReplacementPreview,
} from "./services/quick-replace.service";

/* Pure and exported so the Smart Stock milestone can reuse the scoring. */
export {
  buildAllocationPlan,
  NEAR_EXPIRY_DAYS,
  computeExpirationDate,
  todayAsDate,
  type AllocationPlan,
  type AllocationSlice,
} from "./services/allocation-engine";

export { QuickPrepareWizard } from "./components/quick-prepare-wizard";
export { QuickReplaceScreen } from "./components/quick-replace-screen";
export { ReplaceAccountButton } from "./components/replace-account-button";

export {
  confirmReplacementSchema,
  quickPrepareSchema,
  replaceLookupSchema,
  /*
   * The duration bounds, exported since M09 so Quick Renew applies the SAME
   * limits rather than restating them. A renewal that could run longer than a
   * sale would be a second answer to one question.
   */
  MAX_DURATION_DAYS,
  MIN_DURATION_DAYS,
  type ConfirmReplacementInput,
  type QuickPrepareInput,
  type ReplaceLookupInput,
} from "./validation/quick-prepare.schema";
