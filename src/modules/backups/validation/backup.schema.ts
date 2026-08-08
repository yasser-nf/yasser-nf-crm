import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-zod";
import { z } from "zod";

import { backups } from "@/lib/drizzle/schema";

/**
 * Backup metadata validation.
 *
 * Mirrors the table's check constraints so a caller gets a field-level message
 * instead of a database error. The constraints remain the real guarantee.
 */

export const backupSelectSchema = createSelectSchema(backups);

export const backupInsertSchema = createInsertSchema(backups, {
  filename: z.string().trim().min(1).max(512).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  checksum: z.string().trim().min(1).max(128).optional(),
  errorMessage: z.string().trim().max(2000).optional(),
}).omit({
  id: true,
  createdAt: true,
  completedAt: true,
  verifiedAt: true,
});

export const backupUpdateSchema = createUpdateSchema(backups, {
  filename: z.string().trim().min(1).max(512),
  sizeBytes: z.number().int().nonnegative(),
  checksum: z.string().trim().min(1).max(128),
  errorMessage: z.string().trim().max(2000),
})
  .omit({
    id: true,
    type: true,
    createdBy: true,
    createdAt: true,
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "An update must change at least one field",
  })
  /* Mirrors backups_completed_has_artifact. */
  .refine(
    (value) =>
      value.status === undefined ||
      !["completed", "verified"].includes(value.status) ||
      (Boolean(value.filename) && Boolean(value.checksum)),
    { message: "A completed backup must record a filename and a checksum" },
  )
  /* Mirrors backups_failed_has_reason. */
  .refine((value) => value.status !== "failed" || Boolean(value.errorMessage), {
    message: "A failed backup must record why it failed",
  });

export type BackupSelect = z.infer<typeof backupSelectSchema>;
export type BackupInsert = z.infer<typeof backupInsertSchema>;
export type BackupUpdate = z.infer<typeof backupUpdateSchema>;
