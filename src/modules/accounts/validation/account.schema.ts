import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-zod";
import { z } from "zod";

import { accounts } from "@/lib/drizzle/schema";

/**
 * Account validation.
 *
 * `passwordEncrypted` is omitted from every schema here. A caller supplies a
 * PLAINTEXT password; the repository encrypts it via lib/crypto before it
 * reaches the column. Accepting the ciphertext as input would let a caller write
 * an unencrypted value into a column named `password_encrypted`, which is the
 * exact failure this naming was meant to prevent.
 */

export const accountSelectSchema = createSelectSchema(accounts);

/** The five physical profile rows. An account may sell between one and all of them. */
export const MIN_PROFILE_SLOTS = 1;
export const MAX_PROFILE_SLOTS = 5;

/** Matching the bounds already on Quick Prepare, so the two cannot disagree. */
const MAX_ACCOUNT_DURATION_DAYS = 730;

/**
 * A `YYYY-MM-DD` calendar date.
 *
 * The columns are `date`, not `timestamp`, so anything carrying a time or a
 * zone is rejected rather than silently truncated. `z.iso.date()` also refuses
 * impossible days such as 2026-02-30, which a regex would let through.
 */
const calendarDate = z.iso.date("Use a calendar date such as 2026-03-31");

/**
 * How many of the five profile rows are sellable.
 *
 * Defaulted rather than required, and that is not cosmetic. Supplying any
 * refinement to createInsertSchema REPLACES the generated schema including its
 * optionality — the exact trap that made `healthScore` mandatory and broke every
 * account creation from M03 to M13. Every refined column with a database default
 * must restate `.default()` here or it becomes required again.
 */
const profileSlots = z
  .number({ error: "Choose how many profiles this account sells" })
  .int("Profiles must be a whole number")
  .min(MIN_PROFILE_SLOTS, `An account must sell at least ${MIN_PROFILE_SLOTS} profile`)
  .max(MAX_PROFILE_SLOTS, `An account has only ${MAX_PROFILE_SLOTS} profiles`)
  .default(MAX_PROFILE_SLOTS);

const baseAccountInsert = createInsertSchema(accounts, {
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Email is required")
    .email("Enter a valid email address"),
  country: z
    .string()
    .trim()
    .length(2, "Country must be a 2-letter ISO code")
    .toUpperCase()
    .optional(),
  notes: z.string().trim().max(2000).optional(),
  /**
   * Defaulted, not required.
   *
   * The column is `integer().notNull().default(100)`, so drizzle-zod would have
   * generated this optional. Supplying a refinement REPLACES the generated
   * schema — including its optionality — which silently made it mandatory.
   *
   * Nothing in the create form collects a health score, so every account
   * creation failed validation on a field the user could not see and could not
   * fill in. The resulting field error had no input to attach to, so the screen
   * showed only "Could not create account".
   *
   * This is the same drizzle-zod trap already recorded for the update schemas
   * in M02; it survived here because no account was ever created successfully
   * to reveal it. The range is still enforced, and so is the check constraint
   * on the table.
   */
  healthScore: z.number().int().min(0).max(100).default(100),
  profileSlots,
  /* Both nullable columns: absent means open-ended, which is not the same as expired. */
  validFrom: calendarDate.optional(),
  validUntil: calendarDate.optional(),
}).omit({
  id: true,
  passwordEncrypted: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
  deletedAt: true,
});

/**
 * Creating an account.
 *
 * `durationDays` is an input convenience, not a column. An operator buying an
 * account thinks in "90 days", not in a calendar date, so the service converts
 * it to `valid_until` — see `resolveValidity`. Storing both would be duplicate
 * state that drifts the moment either is edited, which 03_DATABASE.md forbids.
 */
export const accountInsertSchema = baseAccountInsert
  .extend({
    /** Plaintext. Encrypted by the repository, never stored as given. */
    password: z.string().min(1, "Password is required").max(200),

    durationDays: z
      .number()
      .int("Duration must be a whole number of days")
      .positive("Duration must be at least one day")
      .max(MAX_ACCOUNT_DURATION_DAYS, "Duration cannot exceed two years")
      .optional(),
  })
  /*
   * Mirrors the accounts_validity_order check constraint, so a caller gets a
   * field message instead of a database error. The constraint stays the real
   * guarantee; this is the friendly path.
   */
  .refine(
    (value) =>
      value.validFrom === undefined ||
      value.validUntil === undefined ||
      value.validUntil >= value.validFrom,
    { message: "Coverage cannot end before it starts", path: ["validUntil"] },
  );

/**
 * Changing how many profiles an account sells.
 *
 * Its own schema rather than a field on the update schema: the service that
 * applies it also rewrites profile rows and refuses to strand a paying
 * customer, so it must not be reachable through a generic partial update.
 */
export const profileSlotsSchema = z.object({ profileSlots });

/**
 * Replacing the stored Netflix password.
 *
 * M13 §8 asks for old / new / confirm. `currentPassword` is accepted and
 * checked for presence but is deliberately NOT verified against the stored
 * value: the CRM is not the authority on this credential, Netflix is, and a
 * mismatch here would most often mean the stored copy is stale — which is
 * exactly the situation the operator is fixing. Blocking them then would make
 * the field actively harmful.
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().max(200).optional(),
    newPassword: z.string().min(1, "Enter the new password").max(200),
    confirmPassword: z.string().min(1, "Repeat the new password").max(200),
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: "The two passwords do not match",
    path: ["confirmPassword"],
  });

/*
 * Every refinement is `.optional()`. Supplying a schema to createUpdateSchema
 * replaces the generated one entirely, including its optionality — without this,
 * a partial update would be forced to resend every refined field.
 */
export const accountUpdateSchema = createUpdateSchema(accounts, {
  email: z.string().trim().toLowerCase().email("Enter a valid email address").optional(),
  country: z.string().trim().length(2).toUpperCase().optional(),
  notes: z.string().trim().max(2000).optional(),
  healthScore: z.number().int().min(0).max(100).optional(),
  validFrom: calendarDate.optional(),
  validUntil: calendarDate.optional(),
})
  .omit({
    id: true,
    passwordEncrypted: true,
    createdAt: true,
    updatedAt: true,
    archivedAt: true,
    deletedAt: true,
    /*
     * Not editable here. Changing it moves profile rows and can strand a paying
     * customer, so it goes through accountsService.setProfileSlots, which is
     * transactional and separately audited.
     */
    profileSlots: true,
  })
  .extend({
    /** Optional plaintext replacement. Omit to leave the stored password alone. */
    password: z.string().min(1).max(200).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "An update must change at least one field",
  });

export type AccountSelect = z.infer<typeof accountSelectSchema>;
export type AccountInsert = z.infer<typeof accountInsertSchema>;
export type AccountUpdate = z.infer<typeof accountUpdateSchema>;
export type ProfileSlotsInput = z.infer<typeof profileSlotsSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export { MAX_ACCOUNT_DURATION_DAYS };
