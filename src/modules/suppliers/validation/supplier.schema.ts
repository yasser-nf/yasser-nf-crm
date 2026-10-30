import { z } from "zod";

/**
 * What a supplier request may contain (M09B).
 *
 * The NAME is the only required field. Contact and notes are optional because
 * demanding them would mean an operator who knows only a first name records
 * nothing at all, and an unrecorded supplier is the problem this module
 * exists to solve.
 */

export const SUPPLIER_NAME_MAX = 120;
export const SUPPLIER_CONTACT_MAX = 200;
export const SUPPLIER_NOTES_MAX = 2000;

/** Trimmed and whitespace-collapsed; matches the unique index's comparison. */
export const supplierNameSchema = z
  .string({ error: "Enter the supplier's name" })
  .trim()
  .min(1, "Enter the supplier's name")
  .max(SUPPLIER_NAME_MAX, `A name is limited to ${SUPPLIER_NAME_MAX} characters`)
  .transform((value) => value.replace(/\s+/g, " "));

export const createSupplierSchema = z.object({
  name: supplierNameSchema,
  contact: z.string().trim().max(SUPPLIER_CONTACT_MAX).optional(),
  notes: z.string().trim().max(SUPPLIER_NOTES_MAX).optional(),
});

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = z.object({
  name: supplierNameSchema.optional(),
  contact: z.string().trim().max(SUPPLIER_CONTACT_MAX).nullable().optional(),
  notes: z.string().trim().max(SUPPLIER_NOTES_MAX).nullable().optional(),
  /** Hidden from pickers without losing the accounts' provenance. */
  archived: z.boolean().optional(),
});

export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

/**
 * Setting where an account came from.
 *
 * A discriminated union so the impossible combinations cannot be expressed:
 * an owned or unclassified account carries no supplier, and a supplied one
 * may carry a supplier or leave it for triage.
 */
export const accountOwnershipSchema = z.discriminatedUnion("ownership", [
  z.object({ ownership: z.literal("owned") }),
  z.object({ ownership: z.literal("unknown") }),
  z.object({
    ownership: z.literal("supplied"),
    /** Null is "supplied, supplier not recorded yet" — surfaced for triage. */
    supplierId: z.uuid({ error: "Choose the supplier this account came from" }).nullable(),
  }),
]);

export type AccountOwnershipInput = z.infer<typeof accountOwnershipSchema>;

export const assignSupplierSchema = z.object({
  accountId: z.uuid(),
  ownership: accountOwnershipSchema,
});

export type AssignSupplierInput = z.infer<typeof assignSupplierSchema>;
