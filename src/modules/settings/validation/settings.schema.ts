import { createSelectSchema, createUpdateSchema } from "drizzle-zod";
import { z } from "zod";

import { settings } from "@/lib/drizzle/schema";

/**
 * Settings validation.
 *
 * There is no insert schema. 03_DATABASE.md permits one row only, and that row is
 * created by the repository's `ensureExists`, never by a caller supplying its
 * own. Offering an insert schema would advertise an operation the unique index
 * rejects.
 *
 * `values` is an open record because no document defines a single concrete
 * setting, and 01_MASTER_RULES.md forbids inventing business rules. Each setting
 * should gain a typed key here as it is specified.
 */

export const settingsSelectSchema = createSelectSchema(settings);

export const settingsUpdateSchema = createUpdateSchema(settings, {
  values: z.record(z.string(), z.unknown()),
})
  .omit({
    id: true,
    /* The singleton guard is structural. Nothing may write it. */
    singleton: true,
    createdAt: true,
    updatedAt: true,
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "An update must change at least one field",
  });

export type SettingsSelect = z.infer<typeof settingsSelectSchema>;
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;
