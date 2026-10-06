/**
 * Quick Renew module — public API. ADR-003 Rule 2. M09.
 *
 * Adds time to a subscription a customer already holds. It allocates no stock,
 * creates no customer and moves nobody between accounts — Quick Prepare and
 * Quick Replace own those, and this module reuses their rules rather than
 * restating them.
 *
 * The repository is deliberately NOT exported. Its locking read is only correct
 * inside this module's transaction, and handing it to a caller that did not
 * open one would produce a lock-free "read the expiry, then extend it" race —
 * the exact double renewal M09 §13 exists to prevent.
 */
export {
  quickRenewService,
  /* M08 jobs: the receipt scope, for a job type that runs a renewal. */
  QUICK_RENEW_SCOPE,
  type RenewalResult,
} from "./services/quick-renew.service";

/*
 * The read-only half's response shapes. The service object above carries its
 * two entry points, so there is one way in; these are the types a page or a
 * test needs to describe what comes back.
 */
export type {
  RenewableProfile,
  RenewalPreview,
  RenewalQuoteResult,
} from "./services/renewal-lookup.service";

/* The operator-facing wording for a refusal, so no screen invents its own. */
export { blockedRenewalMessage } from "./services/renewal-guards";

/*
 * The renewal rules are pure and carry no `server-only`, so a unit test or
 * another module may import them through this barrel — and the screen imports
 * them directly, because a Client Component cannot pull a barrel that
 * re-exports a server service.
 */
export {
  RENEWAL_PRESETS,
  presetById,
  quoteRenewal,
  renewalBasis,
  renewalLabel,
  type RenewalBasis,
  type RenewalDuration,
  type RenewalPreset,
  type RenewalPresetId,
  type RenewalQuote,
} from "./services/renewal-duration";

export { renewalBlockedReason, type RenewalBlockedReason } from "./services/renewal-eligibility";

/* Components consumed by app/ page composition. */
export { QuickRenewScreen } from "./components/quick-renew-screen";

export {
  confirmRenewalSchema,
  renewLookupSchema,
  renewQuoteSchema,
  renewalDurationSchema,
  type ConfirmRenewalInput,
  type RenewLookupInput,
  type RenewQuoteInput,
} from "./validation/quick-renew.schema";
