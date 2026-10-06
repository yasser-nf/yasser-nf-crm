import { z } from "zod";

import { MAX_DURATION_DAYS, MIN_DURATION_DAYS } from "@/modules/quick-prepare";
import { RENEWAL_PRESETS, type RenewalPresetId } from "../services/renewal-duration";

/**
 * Quick Renew input validation. M09 §5, §8 and §18.
 *
 * The duration bounds are IMPORTED from Quick Prepare rather than restated.
 * M09 §8 says to reuse an existing maximum duration rule if one exists, and one
 * does: a day at the low end, two years at the high end, already applied to
 * every sale and mirrored by the accounts module. A renewal that could run
 * longer than a sale would be a second answer to the same question.
 */

/**
 * The preset ids as a Zod enum, DERIVED from the presets so the offered lengths
 * and the accepted ones cannot drift apart.
 *
 * The cast is to a non-empty tuple, which is the shape `z.enum` requires and
 * which `Array.prototype.map` cannot express. It narrows nothing: the element
 * type stays `RenewalPresetId`, so the parsed value is that union rather than
 * `string` — which is what lets a parsed duration be handed straight to
 * `quoteRenewal` without a second assertion.
 */
const presetEnum = z.enum(
  RENEWAL_PRESETS.map((preset) => preset.id) as [RenewalPresetId, ...RenewalPresetId[]],
);

/**
 * How long to renew for.
 *
 * A discriminated union rather than a nullable pair of fields. "Three months"
 * and "ninety days" are different promises (see `addMonths`), and a shape that
 * could carry both at once, or neither, would make the service guess which the
 * operator meant.
 *
 * The custom branch is where M09 §8's rejections live. `z.number().int()`
 * refuses a decimal and a non-numeric value; `min` refuses zero and anything
 * negative; `max` refuses the absurd. Every one of them renders on the custom
 * input, because the Server Action returns field errors.
 */
export const renewalDurationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), preset: presetEnum }),
  z.object({
    kind: z.literal("custom"),
    days: z
      .number({ error: "Enter a number of days" })
      .int("Days must be a whole number")
      .min(MIN_DURATION_DAYS, "Renew for at least one day")
      .max(MAX_DURATION_DAYS, "A renewal cannot exceed two years"),
  }),
]);

/**
 * Step one: find the account the customer is on.
 *
 * Email only, lower-cased and trimmed by the schema — the same normalisation
 * `replaceLookupSchema` applies, because an operator reading an address off a
 * customer's screen types it however it was shown to them. M09 §5 asks for the
 * existing normalisation rules rather than a new one.
 */
export const renewLookupSchema = z.object({
  accountEmail: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Enter the account email the customer is using")
    .email("Enter a valid email address"),
});

export type RenewLookupInput = z.infer<typeof renewLookupSchema>;

/**
 * Step two: quote a renewal for one profile. Read-only.
 *
 * Separate from the lookup so choosing a duration does not re-read the whole
 * account, and separate from the commit so a quote can be shown without
 * anything being written. The server quotes rather than the browser for the
 * same reason Quick Replace derives its states server-side: one interpretation
 * of the rule, not two that drift.
 */
export const renewQuoteSchema = z.object({
  profileId: z.uuid(),
  duration: renewalDurationSchema,
});

export type RenewQuoteInput = z.infer<typeof renewQuoteSchema>;

/**
 * Step three: commit a renewal the operator has seen and approved.
 *
 * Three of these fields are preconditions rather than instructions, and they
 * are what make a stale confirmation refuse instead of renewing something the
 * operator never saw:
 *
 *   accountId               the account the preview showed
 *   customerId              the customer it showed holding this profile
 *   expectedExpirationDate  the expiry it showed, which the renewal extends
 *
 * The last is the concurrency guard M09 §13 asks for. Two operators who open
 * the same profile both send the expiry they were shown; the first commit moves
 * it, so the second no longer matches what the locked row says and is refused.
 * Neither a shared operation id nor a frontend lock could do that — they are
 * different requests from different people.
 */
export const confirmRenewalSchema = z.object({
  profileId: z.uuid(),
  accountId: z.uuid(),
  customerId: z.uuid(),
  /**
   * What the operator was shown as the current expiry.
   *
   * Nullable because a profile may carry none — a live allocation with no
   * recorded expiry is real in data that predates Quick Prepare. `null` is
   * therefore a meaningful assertion ("it had no expiry"), not an omission, so
   * the field is required and the value may be null.
   */
  expectedExpirationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date")
    .nullable(),
  duration: renewalDurationSchema,
  notes: z.string().trim().max(2000).optional(),

  /**
   * M08 jobs: identifies this RENEWAL, not this request. The page creates it
   * once per quoted renewal and sends the same value on every attempt — a
   * double click, a retry after a lost response, a refresh-and-resubmit — so
   * the server replays the first result instead of renewing twice. Optional
   * here because server code may call without one and gets a fresh key per
   * call, which still protects the adapter's own transaction retries; the
   * Server Action requires it.
   */
  operationId: z.uuid().optional(),
});

export type ConfirmRenewalInput = z.infer<typeof confirmRenewalSchema>;

/** What the Server Actions require on top of the service schemas: the operation id. */
export const renewOperationIdSchema = z.object({
  operationId: z.uuid({ error: "Missing confirmation id" }),
});

export { MAX_DURATION_DAYS, MIN_DURATION_DAYS };
