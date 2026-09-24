"use client";

import { X } from "lucide-react";

import { Button } from "@/shared/ui/button";

/**
 * The bulk action toolbar's frame, shared by Accounts and Problems (M03).
 *
 * Presentation only: the count, the "this page only" rule, the actions a page
 * passes in, and Clear selection. It knows nothing about what the actions do
 * or who may do them — each page decides that, and each action's service
 * decides it again on the server.
 *
 * Renders nothing when nothing is selected, so it is never a permanent fixture.
 * The actions wrap rather than scroll, so every one stays reachable on a phone
 * without widening the page.
 */
export function BulkActionBar({
  count,
  label,
  onClear,
  children,
}: {
  readonly count: number;
  /** e.g. "3 accounts selected" — worded by the page, which knows its noun. */
  readonly label: string;
  readonly onClear: () => void;
  readonly children: React.ReactNode;
}) {
  if (count === 0) {
    return null;
  }

  return (
    <div
      /*
       * A status region, so a screen reader hears the count change as rows are
       * ticked, without the toolbar stealing focus.
       */
      role="status"
      className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 lg:flex-row lg:items-center lg:justify-between"
    >
      <div className="flex flex-col">
        <p className="text-caption font-medium text-foreground">{label}</p>
        <p className="text-caption text-foreground-subtle">
          On this page only. Changing page, search, filter or sort clears it.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {children}

        <Button variant="outline" size="sm" onClick={onClear} className="gap-2">
          <X className="size-4" aria-hidden="true" />
          Clear selection
        </Button>
      </div>
    </div>
  );
}
