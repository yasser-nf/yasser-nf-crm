import "@tanstack/react-query";

import type { AppError } from "@/lib/errors";

/**
 * Registers AppError as the default error type for every query and mutation.
 *
 * ADR-003 guarantees this: services return Result, hooks unwrap it, and the only
 * thing a Failure can carry is an AppError. Declaring it once here means every
 * `useQuery` and `useMutation` in the application gets a correctly typed error
 * without restating the generics, so `error.userMessage` is always available and
 * always type-checked.
 */
declare module "@tanstack/react-query" {
  interface Register {
    defaultError: AppError;
  }
}
