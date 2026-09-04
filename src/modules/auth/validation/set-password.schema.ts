import { z } from "zod";

/**
 * First-password input validation.
 *
 * Deliberately not `buildChangePasswordSchema` with a field removed. That one
 * requires the current password and refuses a new password equal to it — both
 * meaningless for somebody who has never had one, and the first would make the
 * form unfillable.
 *
 * What IS shared is the policy: the minimum length is passed in, from the same
 * configured `security.passwordMinLength` a Super Admin sets on the Security
 * page. A number written here would be a second policy free to disagree with
 * the one an administrator can see.
 */
export function buildSetPasswordSchema(minLength: number) {
  return z
    .object({
      newPassword: z
        .string()
        .min(minLength, `Use at least ${minLength} characters`)
        /* bcrypt's limit. Supabase refuses more, and opaquely. */
        .max(72, "Passwords cannot be longer than 72 characters"),
      confirmPassword: z.string().min(1, "Repeat the password"),
    })
    .refine((data) => data.newPassword === data.confirmPassword, {
      path: ["confirmPassword"],
      message: "The two passwords do not match",
    });
}

export type SetPasswordInput = z.infer<ReturnType<typeof buildSetPasswordSchema>>;
