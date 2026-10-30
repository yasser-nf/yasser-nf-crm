/**
 * What an operator is told when "Suggest another account" finds nothing (M09C).
 *
 * In a file of its own because both halves need the same words: the Quick
 * Prepare service returns it as an error, and the Quick Replace screen renders
 * it from a `blockedReason`. Neither the service (server-only) nor a component
 * can be imported by the other, and two copies of a sentence drift.
 */

export const NO_ALTERNATIVE_MESSAGE = "No other suitable accounts are currently available.";

export const PROPOSAL_UNAVAILABLE_MESSAGE =
  "That account is no longer available — it may have just been sold, developed a problem, " +
  "or run short of validity.";
