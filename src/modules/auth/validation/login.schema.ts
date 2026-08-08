import { z } from "zod";

/**
 * Login input validation.
 *
 * 02_ARCHITECTURE.md: every input is validated, and Zod is the single source of
 * truth for that validation. The inferred type below is what the rest of the
 * module consumes, so the schema and the type can never disagree.
 */
export const loginSchema = z.object({
  email: z
    .string()
    .min(1, "Email is required")
    .email("Enter a valid email address")
    .transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof loginSchema>;
