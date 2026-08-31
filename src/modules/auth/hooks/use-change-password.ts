"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { unwrap } from "@/utils/result";
import { authService } from "../services/auth.service";
import type { ChangePasswordInput } from "../validation/change-password.schema";

/**
 * Change-password mutation.
 *
 * Same boundary as `useLogin`: the service returns a Result, `unwrap` throws its
 * AppError so the mutation's error channel works normally, and the component
 * never sees a Result.
 *
 * No `router.refresh()` and no navigation. Re-authenticating already issued a
 * fresh session for the same user, so nothing on screen is stale — and bouncing
 * someone off the page they just used would hide the confirmation they need.
 *
 * The failure toast is deliberately absent: every error this can produce is a
 * field error or a sentence the form renders inline, next to the input that
 * caused it. A toast would say the same thing twice, in the place the eye is
 * not looking.
 */
export function useChangePassword(context: {
  readonly email: string;
  readonly passwordMinLength: number;
}) {
  return useMutation({
    mutationFn: async (input: ChangePasswordInput) =>
      unwrap(await authService.changePassword(input, context)),
    onSuccess: () => {
      toast.success("Password changed", {
        description: "Use your new password the next time you sign in.",
      });
    },
  });
}
