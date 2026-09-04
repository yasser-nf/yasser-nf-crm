"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { DEFAULT_AUTHENTICATED_ROUTE } from "@/config/constants";
import { unwrap } from "@/utils/result";
import { authService } from "../services/auth.service";
import type { SetPasswordInput } from "../validation/set-password.schema";

/**
 * First-password mutation, for somebody arriving from an invitation.
 *
 * Unlike `useChangePassword` this navigates. Setting the password is the last
 * step of accepting an invitation, and leaving the person on the form afterwards
 * would strand them on a page with nothing left to do — they are already signed
 * in by then, so the dashboard is where they belong.
 *
 * `refresh()` before `replace()` so the server re-reads the session cookies and
 * the dashboard renders as the new user rather than from a guest-time cache.
 */
export function useSetPassword(context: { readonly passwordMinLength: number }) {
  const router = useRouter();

  return useMutation({
    mutationFn: async (input: SetPasswordInput) =>
      unwrap(await authService.setInitialPassword(input, context)),
    onSuccess: () => {
      router.refresh();
      router.replace(DEFAULT_AUTHENTICATED_ROUTE);
    },
  });
}
