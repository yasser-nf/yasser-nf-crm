import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-zod";
import { z } from "zod";

import { customers } from "@/lib/drizzle/schema";

/**
 * Customer validation.
 *
 * Derived from the table with drizzle-zod so validation cannot drift from the
 * schema.
 *
 * The three phone columns are all required on insert. 01_MASTER_RULES.md makes
 * the normalized number the identity key and requires the original and the
 * WhatsApp URL to be stored alongside it — the Phone Engine produces all three
 * together, and accepting a partial set here would let a caller invent one.
 */

/** Mirrors the customers_phone_normalized_digits check constraint. */
const normalizedPhone = z
  .string()
  .trim()
  .regex(/^[0-9]{6,20}$/, "Normalized phone must be 6 to 20 digits with no symbols");

export const customerSelectSchema = createSelectSchema(customers);

export const customerInsertSchema = createInsertSchema(customers, {
  name: z.string().trim().min(1).max(120).optional(),
  phoneOriginal: z.string().trim().min(1, "Phone number is required").max(40),
  phoneNormalized: normalizedPhone,
  whatsappUrl: z.url("WhatsApp URL must be a valid URL"),
  notes: z.string().trim().max(2000).optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  /* Derived from order history, never supplied by a caller. */
  firstPurchaseAt: true,
  lastPurchaseAt: true,
});

export const customerUpdateSchema = createUpdateSchema(customers, {
  name: z.string().trim().min(1).max(120),
  phoneOriginal: z.string().trim().min(1).max(40),
  phoneNormalized: normalizedPhone,
  whatsappUrl: z.url(),
  notes: z.string().trim().max(2000),
})
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "An update must change at least one field",
  })
  /*
   * The three phone fields describe one number. Changing one without the others
   * would leave the identity key disagreeing with what is displayed and with the
   * chat link — a silent data corruption that only surfaces when someone messages
   * the wrong customer.
   */
  .refine(
    (value) => {
      const touched = [value.phoneOriginal, value.phoneNormalized, value.whatsappUrl].filter(
        (field) => field !== undefined,
      );
      return touched.length === 0 || touched.length === 3;
    },
    {
      message:
        "phoneOriginal, phoneNormalized and whatsappUrl describe one number and must be updated together",
    },
  );

export type CustomerSelect = z.infer<typeof customerSelectSchema>;
export type CustomerInsert = z.infer<typeof customerInsertSchema>;
export type CustomerUpdate = z.infer<typeof customerUpdateSchema>;
