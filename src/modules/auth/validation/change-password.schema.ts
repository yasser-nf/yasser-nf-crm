import { z } from "zod";

/**
 * Change-password input validation.
 *
 * The length rule is NOT declared here. `security.passwordMinLength` is already
 * a configured setting — a Super Admin sets it on the Security page, it defaults
 * to 12, and it is bounded 8..128 by `securitySettingsSchema`. Restating a
 * number here would be a second policy, free to disagree with the one an
 * administrator can see and change.
 *
 * So the schema is a factory: the caller supplies the configured minimum and
 * gets a schema that enforces it. Both the form and the service build it from
 * the same value, which is how they cannot drift.
 *
 * 02_ARCHITECTURE.md: never trust frontend validation. The service revalidates
 * through this same factory before it calls Supabase.
 */
export function buildChangePasswordSchema(minLength: number) {
  return (
    z
      .object({
        currentPassword: z.string().min(1, "Enter your current password"),
        newPassword: z
          .string()
          .min(minLength, `Use at least ${minLength} characters`)
          /*
           * Supabase rejects anything over 72 bytes outright — bcrypt's limit —
           * and its error is opaque. Catching it here says something useful.
           */
          .max(72, "Passwords cannot be longer than 72 characters"),
        confirmPassword: z.string().min(1, "Repeat the new password"),
      })
      .refine((data) => data.newPassword === data.confirmPassword, {
        path: ["confirmPassword"],
        message: "The two passwords do not match",
      })
      /*
       * Reported against `newPassword`, not `currentPassword`: the field at fault
       * is the one the operator has to change, and an error under the field they
       * typed correctly reads as a rejection of their current password.
       */
      .refine((data) => data.newPassword !== data.currentPassword, {
        path: ["newPassword"],
        message: "The new password must be different from the current one",
      })
  );
}

export type ChangePasswordInput = z.infer<ReturnType<typeof buildChangePasswordSchema>>;
