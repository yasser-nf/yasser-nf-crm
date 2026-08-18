import { z } from "zod";

import { PROFILES_PER_ACCOUNT } from "@/modules/accounts";
import { isValidAlgerianPhone } from "@/lib/phone";

/**
 * Quick Prepare input validation.
 *
 * The phone check delegates to the Phone Engine rather than restating a regex.
 * 02_ARCHITECTURE.md forbids a feature from normalising a number itself, and a
 * second pattern here would eventually disagree with the first.
 */

/**
 * Upper bound on one preparation.
 *
 * Four accounts' worth. Not a business rule anyone stated — a guard so a typo
 * such as 500 cannot lock hundreds of profile rows in a single transaction.
 */
const MAX_PROFILES_PER_PREPARATION = PROFILES_PER_ACCOUNT * 4;

/** Duration bounds. A day is the smallest unit; two years is beyond any plan sold. */
const MIN_DURATION_DAYS = 1;
const MAX_DURATION_DAYS = 730;

export const quickPrepareSchema = z.object({
  profileCount: z
    .number({ error: "Enter how many profiles are needed" })
    .int("Profiles must be a whole number")
    .min(1, "At least one profile is required")
    .max(
      MAX_PROFILES_PER_PREPARATION,
      `A single preparation is limited to ${MAX_PROFILES_PER_PREPARATION} profiles`,
    ),

  durationDays: z
    .number({ error: "Enter a duration" })
    .int("Duration must be a whole number of days")
    .min(MIN_DURATION_DAYS, "Duration must be at least one day")
    .max(MAX_DURATION_DAYS, "Duration cannot exceed two years"),

  phone: z
    .string()
    .trim()
    .min(1, "Customer phone number is required")
    .refine(isValidAlgerianPhone, "Use 0663947116, 663947116, +213663947116 or 00213663947116"),

  notes: z.string().trim().max(2000).optional(),

  /**
   * M13 §8. The operator confirming they changed the Netflix password on an
   * account that previously served somebody else.
   *
   * Optional here and NEVER trusted: `confirm` re-derives whether the change is
   * required from the accounts it is actually about to allocate, and refuses
   * when the flag is missing. A client that simply omits it cannot proceed, and
   * a client that sends `true` for an account needing no change changes nothing.
   */
  passwordChangeConfirmed: z.boolean().optional(),
});

export type QuickPrepareInput = z.infer<typeof quickPrepareSchema>;

/**
 * Previewing an allocation.
 *
 * An object rather than positional arguments, and validated rather than trusted,
 * for one specific reason: the first version of `previewAllocationAction` took
 * `(profileCount: number)` and simply never forwarded the duration. The service
 * accepted it as an optional second parameter, so nothing failed — the preview
 * silently stopped filtering by account validity and could offer stock that the
 * confirm step then refused.
 *
 * Both fields are REQUIRED here. A caller that omits the duration now gets a
 * validation error instead of a quietly different answer, which is the whole
 * point: preview and confirm must evaluate the same candidates or the preview
 * is worse than useless.
 *
 * The two fields deliberately mirror `quickPrepareSchema`, so the pair cannot
 * drift apart in bounds either.
 */
export const previewAllocationSchema = quickPrepareSchema.pick({
  profileCount: true,
  durationDays: true,
});

export type PreviewAllocationInput = z.infer<typeof previewAllocationSchema>;

/*
 * `replaceAllocationSchema` used to live here — the input contract for a direct,
 * unguarded replacement commit. It carried no replacement account and no
 * password-change confirmation, because the path it fed enforced neither.
 *
 * It was deleted with that path. `confirmReplacementSchema` below is the only
 * replacement contract, and its required fields are what make the guards
 * unconditional rather than opt-in.
 */

/**
 * Looking up a customer's current allocation by the account email they hold.
 *
 * The operator's entry point for Quick Replace: they have the customer on the
 * phone reading out the email that stopped working. They do not have an account
 * id and should not have to find one.
 */
export const replaceLookupSchema = z.object({
  accountEmail: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Enter the account email the customer is using")
    .email("Enter a valid email address"),
  /**
   * Narrows to one customer when the account carries several.
   *
   * Omitted on the first lookup. If more than one customer holds a profile on
   * that account, the preview reports every candidate and asks rather than
   * guessing — replacing the wrong customer's profile is not recoverable by
   * pressing back.
   */
  customerId: z.uuid().optional(),
});

export type ReplaceLookupInput = z.infer<typeof replaceLookupSchema>;

/**
 * Committing a replacement the operator has seen and approved.
 *
 * Carries the profile ids the preview showed. They are NOT trusted as the
 * allocation to make — the confirm step re-selects under lock — they are
 * compared against what the lock finds, so a preview that has gone stale is
 * refused instead of silently replacing something the operator never saw.
 */
export const confirmReplacementSchema = z.object({
  accountId: z.uuid(),
  customerId: z.uuid(),
  /** Profiles the operator was shown as the customer's current allocation. */
  expectedProfileIds: z.array(z.uuid()).min(1, "Nothing was selected to replace"),
  /**
   * The account the preview proposed, so the commit cannot drift to another.
   *
   * REQUIRED. It was optional, and the commit ignored it entirely — the comment
   * above described a guarantee no code provided, and the engine was free to
   * re-plan onto a different account than the operator approved. Optional would
   * leave that bypassable by simply omitting the field, so the field is
   * mandatory and `commitReplacement` refuses rather than substituting.
   */
  replacementAccountId: z.uuid(),
  reason: z.string().trim().max(500).optional(),
  /**
   * M13 §8. The operator confirming they changed the Netflix password on the
   * account being handed over. Required when the preview flagged reuse.
   */
  passwordChangeConfirmed: z.boolean().optional(),
});

export type ConfirmReplacementInput = z.infer<typeof confirmReplacementSchema>;

export { MAX_PROFILES_PER_PREPARATION, MIN_DURATION_DAYS, MAX_DURATION_DAYS };
