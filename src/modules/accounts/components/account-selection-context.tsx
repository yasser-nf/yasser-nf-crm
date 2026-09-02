"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { EMPTY_SELECTION, type Selection } from "../services/account-selection";

/**
 * A read-only mirror of the accounts list selection, for the page header.
 *
 * The table still owns the selection: it holds the state, applies the rules and
 * clears it when the filter changes. This only publishes a copy upward so the
 * Export menu — which sits beside "New account", outside the table — can see
 * what is ticked.
 *
 * A mirror rather than the state itself, and that distinction is the whole
 * reason this file reads the way it does. Holding the state here instead meant
 * the table adjusted a parent's state during its own render, which React
 * rejects: "Cannot update a component while rendering a different component".
 * The pattern the table uses to reset on a filter change is only legal for a
 * component's own state, so the state stays where the rules are.
 *
 * Publishing after commit also keeps the reset honest. The accounts page keys
 * its Suspense boundary on the filter, so a filter change unmounts the table
 * and its selection dies with it; the fresh mount publishes an empty selection
 * on its first commit, and the header follows.
 */

interface AccountSelectionValue {
  readonly selection: Selection;
  /** Called by the table after every commit. Stable, so it cannot loop. */
  readonly publishSelection: (next: Selection) => void;
}

const AccountSelectionContext = createContext<AccountSelectionValue | null>(null);

export function AccountSelectionProvider({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);

  const publishSelection = useCallback((next: Selection) => {
    /*
     * Bail out when nothing changed. The table publishes on every commit, and
     * without this an unrelated re-render would queue a state update that
     * causes another render, which publishes again.
     */
    setSelection((current) => (current === next ? current : next));
  }, []);

  const value = useMemo(() => ({ selection, publishSelection }), [selection, publishSelection]);

  return (
    <AccountSelectionContext.Provider value={value}>{children}</AccountSelectionContext.Provider>
  );
}

/**
 * The published selection, or an empty one outside the provider.
 *
 * Deliberately does not throw. The table renders inside a Suspense boundary
 * that the page may replace with a skeleton, and an accounts screen is not
 * worth crashing over a header menu that would simply have nothing to offer.
 * The Export menu treats an empty selection as "Export selected" being
 * unavailable, which is the truth in that case anyway.
 */
export function useAccountSelection(): AccountSelectionValue {
  return useContext(AccountSelectionContext) ?? FALLBACK;
}

const FALLBACK: AccountSelectionValue = {
  selection: EMPTY_SELECTION,
  publishSelection: () => {},
};
