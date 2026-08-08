"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";

import { DEFAULT_AUTHENTICATED_ROUTE, REDIRECT_QUERY_PARAM } from "@/config/constants";
import { unwrap } from "@/utils/result";
import { authService } from "../services/auth.service";
import type { LoginInput } from "../validation/login.schema";

/**
 * Only a path within this application is an acceptable redirect target.
 *
 * Without this check, `?next=https://example.com` would turn the login page into
 * an open redirect — a phishing primitive that looks like a legitimate link to
 * this CRM.
 */
function toSafeRedirect(target: string | null): string {
  if (!target || !target.startsWith("/") || target.startsWith("//")) {
    return DEFAULT_AUTHENTICATED_ROUTE;
  }

  return target;
}

/**
 * Sign-in mutation.
 *
 * ADR-003: this is the hook boundary where Result meets TanStack Query. The
 * service returns a Result; `unwrap` throws its AppError so the mutation's
 * error channel works normally. Components never see a Result.
 */
export function useLogin() {
  const router = useRouter();
  const searchParams = useSearchParams();

  return useMutation({
    mutationFn: async (input: LoginInput) => unwrap(await authService.signIn(input)),
    onSuccess: () => {
      const destination = toSafeRedirect(searchParams.get(REDIRECT_QUERY_PARAM));

      /*
       * refresh() re-runs middleware and the server layout so the session is
       * picked up, then push() navigates. Without the refresh the destination
       * would render against a stale server view and bounce back to login.
       */
      router.refresh();
      router.push(destination);
    },
  });
}
