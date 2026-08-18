import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-zod";
import { z } from "zod";

import { profileEvents, profiles } from "@/lib/drizzle/schema";

/**
 * Profile and profile-event validation.
 *
 * 01_MASTER_RULES.md: exactly five profiles per account, numbered 1 to 5.
 * PROFILE_NUMBERS below is the single source for that set — it drives the
 * validator here and the creation logic in the repository, so the two cannot
 * disagree.
 */

/** The only permitted profile numbers. Never four, never six, never dynamic. */
export const PROFILE_NUMBERS = [1, 2, 3, 4, 5] as const;

export const PROFILES_PER_ACCOUNT = PROFILE_NUMBERS.length;

const profileNumber = z
  .number()
  .int()
  .min(1)
  .max(PROFILES_PER_ACCOUNT, `Profile number must be between 1 and ${PROFILES_PER_ACCOUNT}`);

export const profileSelectSchema = createSelectSchema(profiles);

export const profileInsertSchema = createInsertSchema(profiles, {
  profileNumber,
  profileName: z.string().trim().min(1).max(60).optional(),
  pin: z
    .string()
    .trim()
    .regex(/^[0-9]{4}$/, "PIN must be exactly 4 digits")
    .optional(),
  durationDays: z.number().int().positive("Duration must be a positive number of days").optional(),
  notes: z.string().trim().max(2000).optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

/*
 * Every refinement is `.optional()`. Supplying a schema to createUpdateSchema
 * replaces the generated one entirely, including its optionality — without this,
 * a partial update would be forced to resend every refined field.
 */
export const profileUpdateSchema = createUpdateSchema(profiles, {
  profileName: z.string().trim().min(1).max(60).optional(),
  pin: z
    .string()
    .trim()
    .regex(/^[0-9]{4}$/, "PIN must be exactly 4 digits")
    .optional(),
  durationDays: z.number().int().positive().optional(),
  notes: z.string().trim().max(2000).optional(),
})
  .omit({
    id: true,
    /* A profile cannot move between accounts, and its number is fixed for life. */
    accountId: true,
    profileNumber: true,
    createdAt: true,
    updatedAt: true,
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "An update must change at least one field",
  })
  /*
   * Mirrors the profiles_held_requires_customer check constraint so the caller
   * gets a field-level message instead of a database error. The constraint
   * remains the real guarantee — this is the friendly path, not the enforcement.
   */
  .refine(
    (value) =>
      value.status === undefined ||
      value.status !== "available" ||
      value.customerId === null ||
      value.customerId === undefined,
    { message: "An available profile cannot have a customer" },
  );

/**
 * The only fields a person may edit on a profile.
 *
 * An explicit allowlist, not an omit-list. M03 forbids changing the profile
 * number, creating profiles and deleting them; M13 adds the allocation fields.
 * Writing the permitted set out means a form cannot submit something the
 * milestone forbids even by accident — `accountId`, `profileNumber`, `status`,
 * `workerId`, the timestamps and the ids are absent because they are absent,
 * not because something remembered to strip them.
 *
 * `status` in particular is NOT here. Expiry is derived from expiration_date
 * (ADR-013 D2), so an editor that could write `expired` would be creating the
 * second source of truth the whole milestone exists to avoid.
 */
export const profileEditSchema = z.object({
  /* Identity — always editable, on any slot. */
  profileName: z.string().trim().min(1, "Profile name is required").max(60).optional(),
  pin: z
    .string()
    .trim()
    .regex(/^[0-9]{4}$/, "PIN must be exactly 4 digits")
    .optional(),
  notes: z.string().trim().max(2000, "Notes are limited to 2000 characters").optional(),

  /*
   * Allocation. Every one of these is validated against the account's own
   * validity by the service before it is written — the profile editor is a
   * consumer of the allocation rules, never a way around them.
   */

  /**
   * The customer, identified the way the rest of the system identifies one.
   *
   * A phone number rather than a customer id, resolved through
   * `customersService.findOrCreateByPhone` — the same path Quick Prepare uses.
   * 01_MASTER_RULES.md makes the normalized number the identity key, so
   * accepting an id here would let a caller attach a profile to a customer that
   * the Phone Engine would have matched to a different, existing record.
   */
  customerPhone: z.string().trim().min(1).optional(),

  saleDate: z.iso.date("Use a calendar date such as 2026-03-31").optional(),
  expirationDate: z.iso.date("Use a calendar date such as 2026-03-31").optional(),
  durationDays: z
    .number()
    .int("Duration must be a whole number of days")
    .positive("Duration must be at least one day")
    .max(730, "Duration cannot exceed two years")
    .optional(),
});

export type ProfileEdit = z.infer<typeof profileEditSchema>;

export const profileEventSelectSchema = createSelectSchema(profileEvents);

export const profileEventInsertSchema = createInsertSchema(profileEvents, {
  notes: z.string().trim().max(2000).optional(),
  /*
   * Constrained to an object so a bare string or array cannot be written into a
   * column the whole history view reads. Must never carry a password.
   */
  metadata: z.record(z.string(), z.unknown()).optional(),
}).omit({
  id: true,
  createdAt: true,
});

export type ProfileSelect = z.infer<typeof profileSelectSchema>;
export type ProfileInsert = z.infer<typeof profileInsertSchema>;
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
export type ProfileEventSelect = z.infer<typeof profileEventSelectSchema>;
export type ProfileEventInsert = z.infer<typeof profileEventInsertSchema>;
