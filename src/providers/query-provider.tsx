"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";

/**
 * TanStack Query provider.
 *
 * ADR-003 defines the contract this relies on: services return Result, and
 * hooks unwrap it so that `queryFn` throws an AppError. Because every failure
 * arriving here is an AppError, the retry policy can make an informed decision
 * instead of blindly retrying.
 */

/** Failures that will never succeed on retry. Retrying them wastes the user's time. */
function isTerminalFailure(error: unknown): boolean {
  return (
    error instanceof ValidationError ||
    error instanceof NotFoundError ||
    error instanceof UnauthorizedError ||
    error instanceof ForbiddenError
  );
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /*
         * 01_MASTER_RULES.md targets a dashboard under one second. Serving
         * cached data while revalidating in the background is how that target
         * is met on repeat visits.
         */
        staleTime: 30_000,
        gcTime: 5 * 60_000,

        /*
         * Refetching every time the window regains focus makes an internal tool
         * feel jumpy for a user who is alt-tabbing between the CRM and
         * WhatsApp all day. Reconnect refetching is kept, because stale data
         * after a dropped connection is a real correctness problem.
         */
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,

        retry: (failureCount, error) => {
          if (isTerminalFailure(error)) {
            return false;
          }
          return failureCount < 2;
        },
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 8000),
      },
      mutations: {
        /*
         * Mutations are never retried automatically. A retried write can create
         * a duplicate record, and this system manages real customer orders.
         */
        retry: false,
      },
    },
  });
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  /*
   * Created in state rather than at module scope. A module-level client would
   * be shared across requests on the server and leak one user's cached data
   * into another user's response.
   */
  const [queryClient] = useState(createQueryClient);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
