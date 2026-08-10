import { z } from "zod";

import { PROBLEM_SEVERITIES, PROBLEM_STATUSES } from "../services/problem-lifecycle";

/**
 * Problem inputs.
 *
 * 02_ARCHITECTURE.md requires validation on both sides of the boundary. These
 * schemas are the server-side half, applied inside the services — a Server
 * Action is a POST endpoint and its input is untrusted regardless of what the
 * form did.
 */

export const problemTypeSchema = z.enum([
  "payment_problem",
  "incorrect_password",
  "invalid_email",
  "something_went_wrong",
  "other",
]);

export const problemSeveritySchema = z.enum(PROBLEM_SEVERITIES);
export const problemStatusSchema = z.enum(PROBLEM_STATUSES);

export const createProblemSchema = z.object({
  accountId: z.string().uuid("An account is required"),
  issueType: problemTypeSchema,
  severity: problemSeveritySchema.default("medium"),
  description: z
    .string()
    .trim()
    .min(10, "Describe what went wrong in at least a few words")
    .max(2000),
  /** Opt-in, so reporting never silently makes somebody the owner. */
  assignToMe: z.boolean().default(false),
});

export type CreateProblemInput = z.infer<typeof createProblemSchema>;

export const updateProblemSchema = z.object({
  status: problemStatusSchema.optional(),
  severity: problemSeveritySchema.optional(),
  description: z.string().trim().min(10).max(2000).optional(),
});

export const assignProblemSchema = z.object({
  /** Null unassigns. */
  assignedTo: z.string().uuid().nullable(),
});

export const resolveProblemSchema = z.object({
  resolutionNote: z
    .string()
    .trim()
    .min(10, "Explain how it was resolved — the next person to hit this needs it")
    .max(2000),
});

export const reopenProblemSchema = z.object({
  reason: z.string().trim().min(5, "Say why it is being reopened").max(2000),
});

export const addNoteSchema = z.object({
  body: z.string().trim().min(1, "A note cannot be empty").max(4000),
});

export type ResolveProblemInput = z.infer<typeof resolveProblemSchema>;
export type AddNoteInput = z.infer<typeof addNoteSchema>;
