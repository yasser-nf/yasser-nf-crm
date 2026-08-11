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
}).omit({
  id: true,
  passwordEncrypted: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
  deletedAt: true,
});

export const accountInsertSchema = baseAccountInsert.extend({
  /** Plaintext. Encrypted by the repository, never stored as given. */
  password: z.string().min(1, "Password is required").max(200),
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
})
  .omit({
    id: true,
    passwordEncrypted: true,
    createdAt: true,
    updatedAt: true,
    archivedAt: true,
    deletedAt: true,
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
