"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ROUTES } from "@/config/constants";
import { unwrap } from "@/utils/result";
import { recordLogoutAction } from "../actions/session.actions";
import { authService } from "../services/auth.service";

/**
 * Sign-out mutation.
 *
 * Clears the query cache on success. Without that, cached data from the
 * previous session stays in memory and the next person to sign in on the same
 * machine sees it before the first refetch completes.
 */
export function useLogout() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      /*
       * Awaited, and before signOut. Afterwards there is no session cookie left
       * for the server to resolve an identity from, so a fire-and-forget call
       * would race the sign-out and usually record nothing.
       */
      await recordLogoutAction();
      unwrap(await authService.signOut());
    },
    onSuccess: () => {
      queryClient.clear();
      router.refresh();
      router.push(ROUTES.LOGIN);
    },
    onError: (error) => {
      /*
       * 01_MASTER_RULES.md: never fail silently. Someone who believes they have
       * signed out on a shared machine, but has not, is a security problem.
       */
      toast.error("Could not sign out", { description: error.userMessage });
    },
  });
}
