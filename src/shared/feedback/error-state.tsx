"use client";

import { RefreshCw, ServerCrash } from "lucide-react";

import { isAppError } from "@/lib/errors";
import { Button } from "@/shared/ui/button";

/**
 * Error state.
 *
 * 04_UI_GUIDELINES.md: every error includes a friendly explanation, a retry
 * button and a safe recovery path. 01_MASTER_RULES.md: never expose stack
 * traces or technical details.
 *
 * Only `AppError.userMessage` is ever rendered. Anything else that reaches here
 * gets a generic sentence, because an unrecognised error is exactly the case
 * where a raw message is most likely to leak internals.
 */
export interface ErrorStateProps {
  readonly error?: unknown;
  readonly title?: string;
  readonly onRetry?: () => void;
}

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

export function ErrorState({ error, title = "Something went wrong", onRetry }: ErrorStateProps) {
  const description = isAppError(error) ? error.userMessage : FALLBACK_MESSAGE;

  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-4 rounded-lg border border-danger/30 bg-danger-subtle px-6 py-16 text-center"
    >
      <div
        aria-hidden="true"
        className="flex size-12 items-center justify-center rounded-lg bg-surface-raised"
      >
        <ServerCrash className="size-5 text-danger" />
      </div>

      <div className="flex max-w-sm flex-col gap-2">
        <h2 className="text-section-title text-foreground">{title}</h2>
        <p className="text-description text-foreground-muted">{description}</p>
      </div>

      {onRetry ? (
        <Button variant="outline" onClick={onRetry} className="gap-2">
          <RefreshCw className="size-4" aria-hidden="true" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}
