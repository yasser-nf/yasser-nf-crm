/**
 * Row selection for the accounts list.
 *
 * Pure, and deliberately outside the component: selection decides what a bulk
 * delete will act on, so the rules deserve to be assertable without rendering a
 * table. Every function here takes the ids currently on screen, because the one
 * thing selection must never do is act on a row the operator cannot see.
 *
 * Selection is UI state and nothing more. Nothing in this file deletes, writes
 * or calls a server action — ticking a box changes a Set, and only a confirmed
 * dialog turns that Set into a request.
 */

/** Selected account ids. A Set: membership is the only question ever asked. */
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

/**
 * Identity of the current result set.
 *
 * Selection is cleared whenever this changes, so a filter, a sort or a page
 * turn can never carry a tick from a row that has scrolled out of existence.
 * Offset is included: page two is a different set of rows from page one.
 */
export function resultSetKey(input: {
  readonly search?: string | undefined;
  readonly status?: string | undefined;
  readonly sortBy: string;
  readonly sortDirection: string;
  readonly offset: number;
}): string {
  return JSON.stringify([
    input.search ?? "",
    input.status ?? "",
    input.sortBy,
    input.sortDirection,
    input.offset,
  ]);
}

/** "3 accounts selected" — the action bar's label. */
export function selectionLabel(count: number): string {
  return `${count} account${count === 1 ? "" : "s"} selected`;
}

/** One selectable row, reduced to what a bulk action needs to decide. */
export interface SelectableAccount {
  readonly id: string;
  readonly hasActiveProblem: boolean;
}

/**
 * Splits the selection by whether the account already has an open problem.
 *
 * The two bulk problem actions are opposites and must never be offered for the
 * same account: declaring a problem on one that already has an open problem
 * would stack a second, and resolving one that has none has nothing to act on.
 *
 * Mixed selections are normal — an operator ticks a page without auditing each
 * badge first — so each action is offered for the accounts it actually applies
 * to, and the dialog states that count rather than the selection size.
 */
export function partitionByProblem(
  rows: readonly SelectableAccount[],
  selection: Selection,
): { readonly withProblem: string[]; readonly withoutProblem: string[] } {
  const withProblem: string[] = [];
  const withoutProblem: string[] = [];

  for (const row of rows) {
    if (!selection.has(row.id)) {
      continue;
    }

    if (row.hasActiveProblem) {
      withProblem.push(row.id);
    } else {
      withoutProblem.push(row.id);
    }
  }

  return { withProblem, withoutProblem };
}
