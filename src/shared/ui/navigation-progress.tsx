"use client";

import { useLinkStatus } from "next/link";

/**
 * The bar that says "your click landed".
 *
 * Next renders a route on the server before it swaps the page in, so between
 * the click and the new screen there is a gap with nothing in it. On a slow
 * route that reads as a dead button, and the honest fix for the gap itself was
 * moving the functions next to the database — this only makes the remaining
 * wait visible.
 *
 * `useLinkStatus` reports the pending state of the Link that owns it, so the
 * indicator is driven by the real navigation rather than by a timer. It appears
 * on the click and leaves when the destination is ready.
 *
 * Deliberately NOT a full-screen overlay. Ordinary navigation must not block the
 * page: the operator can still read what is on screen, and can still change
 * their mind and click somewhere else.
 *
 * Rendered as a child of `Link`, which is the only place `useLinkStatus` works —
 * it reads context the Link provides.
 */
export function NavigationProgress() {
  const { pending } = useLinkStatus();

  if (!pending) {
    return null;
  }

  return (
    <span
      role="status"
      aria-label="Loading page"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden rounded-full"
    >
      {/*
        An indeterminate sweep rather than a percentage. Nothing here knows how
        far along the navigation is, and inventing a number would be a lie that
        stalls at 90% — the failure mode of every fake progress bar.
      */}
      <span className="absolute inset-y-0 -left-1/3 w-1/3 animate-[navsweep_1s_ease-in-out_infinite] rounded-full bg-primary" />
    </span>
  );
}
