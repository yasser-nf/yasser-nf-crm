import { z } from "zod";

import {
  MAX_RENEWAL_DAYS,
  MIN_RENEWAL_DAYS,
  RENEWAL_MONTH_OPTIONS,
  type RenewalDuration,
} from "../services/renewal-dates";

/**
 * What a renewal request may contain (M09A).
 *
 * The duration is a discriminated union rather than a loose number so "three
 * months" cannot arrive as the 90 days it is not. The server recomputes every
 * date from it; nothing the browser calculates is trusted.
 */

export const accountSearchSchema = z.object({
  email: z.string().trim().min(2, "Enter at least two characters of the account email").max(120),
});

export type AccountSearchInput = z.infer<typeof accountSearchSchema>;

export const renewalDurationSchema = z.discriminatedUnion("unit", [
  z.object({
    unit: z.literal("months"),
    months: z.union(
      RENEWAL_MONTH_OPTIONS.map((value) => z.literal(value)) as unknown as [
        z.ZodLiteral<1>,
        z.ZodLiteral<2>,
        z.ZodLiteral<3>,
        z.ZodLiteral<6>,
        z.ZodLiteral<12>,
      ],
      { error: "Choose one of the offered periods" },
    ),
  }),
  z.object({
    unit: z.literal("days"),
    days: z
      .number({ error: "Enter how many days to add" })
      .int("Days must be a whole number")
      .min(MIN_RENEWAL_DAYS, "Add at least one day")
      .max(MAX_RENEWAL_DAYS, `A single renewal is limited to ${MAX_RENEWAL_DAYS} days`),
  }),
]) satisfies z.ZodType<RenewalDuration>;

export const renewalPreviewSchema = z.object({
  profileId: z.uuid(),
  duration: renewalDurationSchema,
});

export type RenewalPreviewInput = z.infer<typeof renewalPreviewSchema>;

export const confirmRenewalSchema = z.object({
  profileId: z.uuid(),
  duration: renewalDurationSchema,

  /**
   * The expiry the operator was shown. Re-checked against the locked row, so a
   * preview that went stale — someone else renewed, replaced or unassigned the
   * profile meanwhile — is refused rather than silently applied to a different
   * period than the one approved.
   */
  expectedExpirationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "The preview is out of date. Look the profile up again."),

  /**
   * Identifies the RENEWAL, not the request: the page creates it once per
   * previewed renewal and repeats it on every attempt, so a double click or a
   * retry after a lost response replays the first result instead of adding the
   * period twice. Required by the Server Action (M08 convention).
   */
  operationId: z.uuid().optional(),
});

export type ConfirmRenewalInput = z.infer<typeof confirmRenewalSchema>;

/** What the Server Actions require on top of the service schema. */
export const renewalOperationIdSchema = z.object({
  operationId: z.uuid({ error: "Missing confirmation id" }),
});
