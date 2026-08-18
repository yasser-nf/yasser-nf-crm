/**
 * Quick Prepare module — public API. ADR-003 Rule 2.
 *
 * The allocation engine. Owns selection, the sale transaction and replacement.
 *
 * The repository is deliberately not exported. Its locking read is only correct
 * inside this module's transaction, and handing it to a caller that does not
 * open one would produce a lock-free "check then allocate" race.
 */
export { quickPrepareService } from "./services/quick-prepare.service";
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
  type ConfirmReplacementInput,
  type QuickPrepareInput,
  type ReplaceLookupInput,
} from "./validation/quick-prepare.schema";
