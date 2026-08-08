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
});

export type QuickPrepareInput = z.infer<typeof quickPrepareSchema>;

/** Replacing an allocation reuses the original request, so only the target is new. */
export const replaceAllocationSchema = z.object({
  accountId: z.uuid(),
  customerId: z.uuid(),
  reason: z.string().trim().max(500).optional(),
});

export type ReplaceAllocationInput = z.infer<typeof replaceAllocationSchema>;

export { MAX_PROFILES_PER_PREPARATION, MIN_DURATION_DAYS, MAX_DURATION_DAYS };
