import { z } from "zod";

/**
 * Creating a user directly. ADR-014 replaces the invitation-only rule.
 *
 * Its own file, free of the Drizzle table imports in user.schema.ts, because
 * the Create User form builds the same schema in the browser: one set of rules
 * and messages for the form and the service, and no table definitions shipped
 * to the client to get it.
 *
 * A factory, like `buildSetPasswordSchema`: the minimum length is the configured
 * `security.passwordMinLength` a Super Admin sets on the Security page, passed
 * in by whoever builds the schema. The service builds it from the stored policy,
 * so a caller cannot lower the bar by sending a different number.
 *
 * The password is validated here and then handed to Supabase Auth, which hashes
 * and stores it. No message below echoes a value back — Zod messages name the
 * rule, never the input — so a field error can be returned to the browser
 * without returning the password with it.
 */
export function buildCreateUserSchema(passwordMinLength: number) {
  return z.object({
    name: z.string().trim().min(1, "Name is required").max(120),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, "Email is required")
      .email("Enter a valid email address"),
    password: z
      .string()
      .min(passwordMinLength, `Use at least ${passwordMinLength} characters`)
      /* bcrypt's limit. Supabase refuses more, and opaquely. */
      .max(72, "Passwords cannot be longer than 72 characters"),
    role: z.enum(["super_admin", "worker"], { message: "Choose a valid role" }),
  });
}

export type CreateUserInput = z.infer<ReturnType<typeof buildCreateUserSchema>>;
