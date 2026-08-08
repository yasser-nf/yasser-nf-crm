"use client";

import { useEffect } from "react";

import { logger } from "@/lib/logger";
import { ErrorState } from "@/shared/feedback/error-state";

/**
 * Route error boundary.
 *
 * 04_UI_GUIDELINES.md: every error needs a friendly explanation, a retry button
 * and a safe recovery path.
 *
 * The `error` argument is a plain Error by the time React hands it over — Next
 * strips server errors before they cross to the client — so ErrorState falls
 * back to generic wording rather than rendering a message that could contain
 * internals.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error("Unhandled route error", error, { digest: error.digest });
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md">
        <ErrorState onRetry={reset} />
      </div>
    </div>
  );
}
