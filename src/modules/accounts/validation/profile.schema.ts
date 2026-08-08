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

export const profileUpdateSchema = createUpdateSchema(profiles, {
  profileName: z.string().trim().min(1).max(60),
  pin: z
    .string()
    .trim()
    .regex(/^[0-9]{4}$/, "PIN must be exactly 4 digits"),
  durationDays: z.number().int().positive(),
  notes: z.string().trim().max(2000),
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

export const profileEventSelectSchema = createSelectSchema(profileEvents);

export const profileEventInsertSchema = createInsertSchema(profileEvents, {
  notes: z.string().trim().max(2000).optional(),
  /*
   * Constrained to an object so a bare string or array cannot be written into a
   * column the whole history view reads. Must never carry a password.
   */
  data: z.record(z.string(), z.unknown()).optional(),
}).omit({
  id: true,
  createdAt: true,
});

export type ProfileSelect = z.infer<typeof profileSelectSchema>;
export type ProfileInsert = z.infer<typeof profileInsertSchema>;
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
export type ProfileEventSelect = z.infer<typeof profileEventSelectSchema>;
export type ProfileEventInsert = z.infer<typeof profileEventInsertSchema>;
