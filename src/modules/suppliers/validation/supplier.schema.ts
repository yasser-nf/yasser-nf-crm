import { z } from "zod";

import {
  MAX_SUPPLIER_NAME_LENGTH,
  MAX_SUPPLIER_NOTES_LENGTH,
  cleanSupplierName,
} from "../services/supplier-name";

/**
 * Supplier input validation. M10 §5 and §18.
 *
 * The name rules delegate to `supplier-name.ts` rather than restating a regex,
 * for the same reason the Quick Prepare schema delegates its phone check to the
 * Phone Engine: a second pattern here would eventually disagree with the first,
 * and the first is what the database's unique index is built on.
 *
 * `transform` rather than `trim` alone. Trimming would accept "Supplier  A"
 * with a double space as distinct from "Supplier A"; `cleanSupplierName`
 * collapses the run, so what reaches the service is already the form that will
 * be stored and the form `normalizeSupplierName` will compare.
 */

const supplierName = z
  .string({ error: "Enter a supplier name" })
  .transform(cleanSupplierName)
  /*
   * Checked AFTER cleaning, so a whitespace-only name fails as "required"
   * rather than passing a length check on its spaces. M10 §5 names this case
   * specifically.
   */
  .refine((value) => value.length > 0, "Supplier name is required")
  .refine(
    (value) => value.length <= MAX_SUPPLIER_NAME_LENGTH,
    `Supplier name is limited to ${MAX_SUPPLIER_NAME_LENGTH} characters`,
  );

const supplierNotes = z
  .string()
  .trim()
  .max(MAX_SUPPLIER_NOTES_LENGTH, `Notes are limited to ${MAX_SUPPLIER_NOTES_LENGTH} characters`)
  .optional();

export const supplierCreateSchema = z.object({
  name: supplierName,
  notes: supplierNotes,
});

export type SupplierCreateInput = z.infer<typeof supplierCreateSchema>;

/**
 * Editing a supplier.
 *
 * Name and notes only. Status is NOT here: activating and deactivating go
 * through their own service calls, which audit a distinct event (§21) and —
 * for deactivation — answer a question a generic update cannot, namely what
 * happens to the accounts that already point at it. The same separation
 * `profileSlots` has from `accountUpdateSchema`.
 */
export const supplierUpdateSchema = z
  .object({
    name: supplierName.optional(),
    /** Empty string clears the note, so it must be distinguishable from absent. */
    notes: supplierNotes,
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "An update must change at least one field",
  });

export type SupplierUpdateInput = z.infer<typeof supplierUpdateSchema>;

/** Listing and searching. M10 §17 and §18. */
export const supplierFilterSchema = z.object({
  /** Server-side name search. Simple `ilike`; no search engine (§18). */
  search: z.string().trim().max(MAX_SUPPLIER_NAME_LENGTH).optional(),
  /** "all" is the default rather than a missing value, so the URL is explicit. */
  status: z.enum(["all", "active", "inactive"]).default("all"),
});

export type SupplierFilterInput = z.infer<typeof supplierFilterSchema>;

/**
 * Assigning an account to a supplier, or back to "My Account". M10 §7 and §22.
 *
 * `supplierId: null` is MY ACCOUNT and is a deliberate value, not an omission —
 * so the field is required and nullable. A missing field would make "set this
 * account back to ours" indistinguishable from a malformed request.
 */
export const accountSupplierSchema = z.object({
  accountId: z.uuid(),
  supplierId: z.uuid().nullable(),
});

export type AccountSupplierInput = z.infer<typeof accountSupplierSchema>;

/** A supplier id by itself: deactivate, reactivate, read one. */
export const supplierIdSchema = z.object({ supplierId: z.uuid() });

export { MAX_SUPPLIER_NAME_LENGTH, MAX_SUPPLIER_NOTES_LENGTH };
