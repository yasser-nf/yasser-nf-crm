"use client";

import { History, Info, Shuffle } from "lucide-react";

import { Button } from "@/shared/ui/button";

/**
 * "Suggest another account", with what it found (M09C).
 *
 * One component for Quick Prepare, Quick Replace and the account page's Replace
 * dialog, so the three ask and answer the same way. It renders only; the hooks
 * in `use-alternatives` decide what to request and what to keep.
 *
 * The notice is `role="status"`, not an alert: "no other account" is an answer,
 * not a failure, and the current suggestion stays on screen beside it.
 */
export function SuggestAnother({
  onSuggest,
  isSearching,
  disabled = false,
  notice,
  earlier,
  onReturnTo,
}: {
  readonly onSuggest: () => void;
  readonly isSearching: boolean;
  /** True while something else (a confirmation) is in flight. */
  readonly disabled?: boolean;
  readonly notice: string | null;
  readonly earlier: readonly { readonly key: string; readonly label: string }[];
  readonly onReturnTo: (index: number) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Button
        type="button"
        variant="outline"
        onClick={onSuggest}
        loading={isSearching}
        loadingLabel="Finding another account"
        disabled={disabled || isSearching}
        className="h-11 w-full gap-2 sm:w-auto sm:self-start"
      >
        <Shuffle className="size-4" aria-hidden="true" />
        Suggest another account
      </Button>

      {notice ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-border bg-background-secondary p-3 text-caption text-foreground-muted"
        >
          <Info className="mt-0.5 size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
          <span className="min-w-0">{notice}</span>
        </p>
      ) : null}

      {earlier.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-caption text-foreground-subtle">
            <History className="size-3.5" aria-hidden="true" />
            Earlier suggestions — checked again before you can use one
          </p>
          <ul className="flex flex-col gap-1.5">
            {earlier.map((entry, index) => (
              <li
                key={entry.key}
                className="flex items-center justify-between gap-3 rounded-md bg-background-secondary px-3 py-2"
              >
                <span className="min-w-0 truncate text-caption text-foreground-muted">
                  {entry.label}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onReturnTo(index)}
                  disabled={disabled || isSearching}
                  className="shrink-0"
                >
                  Use this
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
