import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

import { auditLogs } from "@/lib/drizzle/schema";

/**
 * Audit log validation.
 *
 * There is no update schema and no delete schema. 01_MASTER_RULES.md states the
 * audit log is immutable: never deleted, never modified. The way to guarantee
 * that in a typed codebase is to never write the code that would do it.
 */

export const auditLogSelectSchema = createSelectSchema(auditLogs);

export const auditLogInsertSchema = createInsertSchema(auditLogs, {
  entityId: z.uuid(),
  actorEmail: z.email().optional(),
  /*
   * Objects only. A snapshot must be a record so it can be diffed and rendered;
   * a bare string or array would break every consumer.
   */
  before: z.record(z.string(), z.unknown()).nullish(),
  after: z.record(z.string(), z.unknown()).nullish(),
  ipAddress: z.string().trim().max(64).optional(),
  userAgent: z.string().trim().max(512).optional(),
}).omit({
  id: true,
  createdAt: true,
});

export type AuditLogSelect = z.infer<typeof auditLogSelectSchema>;
export type AuditLogInsert = z.infer<typeof auditLogInsertSchema>;
