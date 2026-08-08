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
  healthScore: z.number().int().min(0).max(100),
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

export const accountUpdateSchema = createUpdateSchema(accounts, {
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  country: z.string().trim().length(2).toUpperCase(),
  notes: z.string().trim().max(2000),
  healthScore: z.number().int().min(0).max(100),
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
