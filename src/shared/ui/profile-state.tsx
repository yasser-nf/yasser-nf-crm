import { cn } from "@/utils/cn";

/**
 * The visual vocabulary for a profile slot's state.
 *
 * One definition, shared. It began inside the accounts module's
 * `ProfileIndicators`, which was correct while the accounts list and the account
 * detail page were the only screens showing slots. Quick Replace shows them too,
 * from a Client Component that cannot import the accounts barrel — that barrel
 * re-exports `server-only` services, and pulling it into the client bundle is a
 * build error.
 *
 * Copying the four colours into a second component would have been the easy way
 * out and would have produced exactly what 04_UI_GUIDELINES.md forbids: two
 * visual systems for one concept, free to drift. So the vocabulary moved here,
 * to the design system, and both consumers read it.
 *
 * This file holds no domain logic. Which state a slot is in is decided by
 * `profileCellState` in the accounts module, and nothing here second-guesses it.
 *
 * COLOURS
 *
 *   sold          green    allocated and inside the customer's window
 *   expiring_soon yellow   allocated and inside the window, but within a few
 *                          days of closing. Yellow rather than the orange used
 *                          by `blocked`, because the two appear on the same row
 *                          and one hue apart is not a distinction anybody can
 *                          act on. Nothing is wrong yet — it is a prompt to
 *                          renew, not a fault.
 *   available     neutral  free stock — quiet, because "nothing to do" is
 *                          the most common state and must not shout
 *   expired       red      was allocated, the window closed
 *   not_for_sale  dashed   not stock at all. Dashed outline and reduced
 *                          opacity rather than a fill, so it reads as absent
 *                          rather than as a fourth kind of status.
 *   blocked       orange   free, but the account cannot sell it right now — an
 *                          open problem, an unhealthy status, or expired
 *                          coverage. Orange rather than red: nothing is broken
 *                          about the slot itself, and it becomes stock again the
 *                          moment the account does.
 */

/**
 * Kept structurally identical to the domain's `ProfileCellState`.
 *
 * Deliberately not imported from the accounts module: the design system must not
 * depend on a feature module. The consumers index these maps with the domain
 * type, so if the domain gains a state and this does not, those lookups stop
 * typechecking — the drift is caught at compile time rather than by a missing
 * colour in production.
 */
export type ProfileSlotState =
  "sold" | "expiring_soon" | "available" | "expired" | "not_for_sale" | "blocked";

export const PROFILE_STATE_STYLES: Record<ProfileSlotState, string> = {
  sold: "border-success/40 bg-success-subtle text-success",
  expiring_soon: "border-caution/40 bg-caution-subtle text-caution",
  available: "border-border bg-surface-raised text-foreground-muted",
  expired: "border-danger/40 bg-danger-subtle text-danger",
  not_for_sale: "border-dashed border-border bg-transparent text-foreground-subtle opacity-50",
  blocked: "border-warning/40 bg-warning-subtle text-warning",
};

export const PROFILE_STATE_LABELS: Record<ProfileSlotState, string> = {
  sold: "sold, active",
  expiring_soon: "expiring soon",
  available: "available",
  expired: "expired allocation",
  not_for_sale: "not for sale",
  blocked: "blocked by account",
};

const LEGEND_ORDER: readonly ProfileSlotState[] = [
  "sold",
  /* Beside sold, because it is a stage of sold rather than a separate fate. */
  "expiring_soon",
  "available",
  "blocked",
  "expired",
  "not_for_sale",
];

/**
 * The legend, so the colours do not have to be guessed.
 *
 * Rendered once per screen rather than repeated per row.
 */
export function ProfileStateLegend({ className }: { className?: string }) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-2", className)}>
      {LEGEND_ORDER.map((state) => (
        <li key={state} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn("size-3 rounded-sm border", PROFILE_STATE_STYLES[state])}
          />
          <span className="text-caption text-foreground-subtle">{PROFILE_STATE_LABELS[state]}</span>
        </li>
      ))}
    </ul>
  );
}
