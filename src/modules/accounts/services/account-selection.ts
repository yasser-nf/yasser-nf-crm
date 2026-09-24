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

export {
  EMPTY_SELECTION,
  actionableIds,
  allSelected,
  someSelected,
  toggleAll,
  toggleSelected,
  type Selection,
} from "@/utils/selection";

import type { Selection } from "@/utils/selection";

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
