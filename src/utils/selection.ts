/**
 * Row selection for list pages — Accounts and Problems (M03).
 *
 * Pure, and deliberately outside any component: selection decides what a bulk
 * action will act on, so the rules deserve to be assertable without rendering
 * a table. Every function takes the ids currently on screen, because the one
 * thing selection must never do is act on a row the operator cannot see.
 *
 * Selection is UI state and nothing more. Nothing here writes or calls a server
 * action — ticking a box changes a Set, and only a confirmed dialog turns that
 * Set into a request.
 *
 * Moved from the accounts module when Problems gained the same selection, so
 * both lists share one set of rules rather than two copies.
 */

/** Selected row ids. A Set: membership is the only question ever asked. */
export type Selection = ReadonlySet<string>;

export const EMPTY_SELECTION: Selection = new Set<string>();

/** Adds or removes one id, leaving the rest untouched. */
export function toggleSelected(selection: Selection, id: string): Selection {
  const next = new Set(selection);

  if (!next.delete(id)) {
    next.add(id);
  }

  return next;
}

/**
 * Selects every id on screen, or clears them.
 *
 * `visibleIds` is one page, never the whole result set. Selecting rows the
 * operator has not seen — the other 400 matches behind a filter — would make
 * "Select all" a far bigger promise than it looks, and the delete that follows
 * would be unrecoverable.
 */
export function toggleAll(selection: Selection, visibleIds: readonly string[]): Selection {
  return allSelected(selection, visibleIds) ? EMPTY_SELECTION : new Set(visibleIds);
}

/** True when every visible row is selected, and there is at least one. */
export function allSelected(selection: Selection, visibleIds: readonly string[]): boolean {
  return visibleIds.length > 0 && visibleIds.every((id) => selection.has(id));
}

/** True when some but not all visible rows are selected — the header's third state. */
export function someSelected(selection: Selection, visibleIds: readonly string[]): boolean {
  return visibleIds.some((id) => selection.has(id)) && !allSelected(selection, visibleIds);
}

/**
 * The ids a bulk action may actually touch.
 *
 * The intersection of what is selected and what is on screen, in the order the
 * rows appear. This is the safety net: if selection ever outlived a filter
 * change through some future refactor, the stale ids would be dropped here
 * rather than deleted. Callers must use this rather than the raw Set.
 */
export function actionableIds(selection: Selection, visibleIds: readonly string[]): string[] {
  return visibleIds.filter((id) => selection.has(id));
}
