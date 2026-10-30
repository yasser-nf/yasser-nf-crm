"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { ActionError } from "@/lib/errors";
import {
  previewAllocationAction,
  previewReplacementAction,
  type ActionResult,
} from "../actions/quick-prepare.actions";
import {
  NO_ALTERNATIVE_MESSAGE,
  PROPOSAL_UNAVAILABLE_MESSAGE,
} from "../services/alternative-messages";
import type { PreparationPreview } from "../services/quick-prepare.service";
import type { ReplacementPreview } from "../services/quick-replace.service";

/**
 * "Suggest another account" (M09C).
 *
 * WHAT THIS HOLDS, AND WHAT IT DOES NOT
 *
 * A suggestion reserves nothing — the preview is a plain read (ADR-007 D4) —
 * so turning one down has nothing to release, and an abandoned page strands no
 * stock. What a workflow does hold is the list of accounts it has already been
 * shown. That list lives here, in this page's memory, and only here: it is sent
 * with each request so the engine plans from what remains, and it disappears
 * with the page. No account is blacklisted for anyone else, or for the next
 * order.
 *
 * The list is a convenience, never a control. The server re-applies every
 * eligibility rule on each request, and confirmation re-checks the chosen
 * account under lock and refuses if it has gone.
 *
 * A FAILED SEARCH CHANGES NOTHING
 *
 * The current suggestion is replaced only on success. An error, or an empty
 * answer, leaves the operator looking at the account they already had, with a
 * notice beside it — never at a blank review.
 */

function unwrapAction<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

function messageOf(error: unknown): string {
  return error instanceof ActionError ? error.userMessage : "Could not find another account.";
}

function union(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])];
}

/* ---------------------------------------------------------------- Quick Prepare */

function preparationAccountIds(preview: PreparationPreview): string[] {
  return preview.accounts.map((account) => account.accountId);
}

/**
 * Alternatives for a Quick Prepare review.
 *
 * `current` is the suggestion on screen and `onChange` replaces it. The page
 * owns that state because confirmation reads it; this hook owns only what was
 * seen along the way.
 *
 * The order (count and duration) is read back from `current` — what the server
 * planned — rather than from the form, so an alternative is always for the same
 * order the operator reviewed. Changing the order means going back to the form,
 * and a fresh preview from there calls `begin`, which starts a new exclusion
 * list for the new order.
 */
export function usePreparationAlternatives({
  current,
  onChange,
}: {
  readonly current: PreparationPreview | null;
  readonly onChange: (next: PreparationPreview) => void;
}) {
  const [seen, setSeen] = useState<readonly string[]>([]);
  const [earlier, setEarlier] = useState<readonly PreparationPreview[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const search = useMutation({
    mutationFn: async (input: {
      profileCount: number;
      durationDays: number;
      excludeAccountIds?: string[];
      accountIds?: string[];
    }) => unwrapAction(await previewAllocationAction(input)),
  });

  /** A new order: forget everything the previous one was shown. */
  function begin(first: PreparationPreview) {
    setSeen(preparationAccountIds(first));
    setEarlier([]);
    setNotice(null);
    search.reset();
  }

  /** Every account seen so far is excluded, not just the one on screen. */
  function suggestAnother() {
    if (!current || search.isPending) {
      return;
    }

    const exclude = union(seen, preparationAccountIds(current));
    setNotice(null);

    search.mutate(
      {
        profileCount: current.requested,
        durationDays: current.durationDays,
        excludeAccountIds: exclude,
      },
      {
        onSuccess: (next) => {
          setEarlier((list) => [...list, current]);
          setSeen(union(exclude, preparationAccountIds(next)));
          onChange(next);
        },
        onError: (error) => setNotice(messageOf(error)),
      },
    );
  }

  /**
   * Back to an earlier suggestion, re-checked by the server first.
   *
   * Restoring it from memory would show validity and password-change flags
   * from minutes ago. Asking the server for exactly those accounts returns
   * their state now — or says they have gone, in which case the entry is
   * dropped rather than offered again.
   */
  function returnTo(index: number) {
    const target = earlier[index];

    if (!current || !target || search.isPending) {
      return;
    }

    setNotice(null);

    search.mutate(
      {
        profileCount: current.requested,
        durationDays: current.durationDays,
        accountIds: preparationAccountIds(target),
      },
      {
        onSuccess: (next) => {
          setEarlier((list) => [...list.filter((_, at) => at !== index), current]);
          onChange(next);
        },
        onError: (error) => {
          setEarlier((list) => list.filter((_, at) => at !== index));
          setNotice(messageOf(error));
        },
      },
    );
  }

  return {
    begin,
    suggestAnother,
    returnTo,
    earlier: earlier.map((preview) => ({
      key: preparationAccountIds(preview).join(":"),
      label: preview.accounts.map((account) => account.email).join(", "),
    })),
    isSearching: search.isPending,
    notice,
  } as const;
}

/* ---------------------------------------------------------------- Quick Replace */

/** The replacement on screen, and the customer and profiles it is for. */
function proposalOf(preview: ReplacementPreview) {
  return {
    accountId: preview.replacement?.account.id ?? null,
    customerId: preview.selected?.customer.id ?? null,
    profileIds: (preview.selected?.profiles ?? []).map((profile) => profile.id).sort(),
  };
}

/**
 * The alternative must be for the SAME customer and the SAME held profiles.
 *
 * The request names the customer, so this should always hold. If the
 * customer's allocation moved in the meantime — another operator replaced it,
 * say — swapping in a preview for a different set of profiles would quietly
 * change what the operator is about to replace. Refused instead.
 */
function sameTarget(left: ReplacementPreview, right: ReplacementPreview): boolean {
  const a = proposalOf(left);
  const b = proposalOf(right);

  return (
    a.customerId === b.customerId &&
    a.profileIds.length === b.profileIds.length &&
    a.profileIds.every((id, index) => id === b.profileIds[index])
  );
}

function emptyAnswerMessage(preview: ReplacementPreview): string {
  switch (preview.blockedReason) {
    case "proposal_unavailable":
      return PROPOSAL_UNAVAILABLE_MESSAGE;
    case "no_other_account":
    case "no_stock":
    case "insufficient_validity":
      return NO_ALTERNATIVE_MESSAGE;
    default:
      return "Could not find another account.";
  }
}

/**
 * Alternatives for a Quick Replace review.
 *
 * Every request repeats the lookup that produced `current` — the same account
 * email and the same chosen customer — so the failing account, the customer and
 * the profiles being replaced cannot change; only the proposed replacement can.
 */
export function useReplacementAlternatives({
  accountEmail,
  current,
  onChange,
}: {
  readonly accountEmail: string | null;
  readonly current: ReplacementPreview | null;
  readonly onChange: (next: ReplacementPreview) => void;
}) {
  const [seen, setSeen] = useState<readonly string[]>([]);
  const [earlier, setEarlier] = useState<readonly ReplacementPreview[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const search = useMutation({
    mutationFn: async (input: unknown) => unwrapAction(await previewReplacementAction(input)),
  });

  /** A new lookup or a different customer: a new workflow. */
  function begin(first: ReplacementPreview | null) {
    const id = first ? proposalOf(first).accountId : null;
    setSeen(id ? [id] : []);
    setEarlier([]);
    setNotice(null);
    search.reset();
  }

  /** Swaps the proposal in only when it is for exactly the same target. */
  function accept(next: ReplacementPreview, from: ReplacementPreview): boolean {
    if (!sameTarget(next, from)) {
      setNotice("This customer's allocation has changed. Look them up again.");
      return false;
    }

    if (!next.replacement) {
      setNotice(emptyAnswerMessage(next));
      return false;
    }

    onChange(next);
    return true;
  }

  function suggestAnother() {
    const target = current ? proposalOf(current) : null;

    if (!current || !target?.accountId || !target.customerId || !accountEmail) {
      return;
    }

    if (search.isPending) {
      return;
    }

    const exclude = union(seen, [target.accountId]);
    setNotice(null);

    search.mutate(
      { accountEmail, customerId: target.customerId, excludeAccountIds: exclude },
      {
        onSuccess: (next) => {
          if (accept(next, current)) {
            setEarlier((list) => [...list, current]);
            const id = proposalOf(next).accountId;
            setSeen(id ? union(exclude, [id]) : exclude);
          }
        },
        onError: (error) => setNotice(messageOf(error)),
      },
    );
  }

  /** Back to an earlier proposal, re-checked by the server first. */
  function returnTo(index: number) {
    const target = earlier[index];
    const proposal = target ? proposalOf(target) : null;

    if (!current || !proposal?.accountId || !proposal.customerId || !accountEmail) {
      return;
    }

    if (search.isPending) {
      return;
    }

    setNotice(null);

    search.mutate(
      {
        accountEmail,
        customerId: proposal.customerId,
        replacementAccountId: proposal.accountId,
      },
      {
        onSuccess: (next) => {
          const kept = accept(next, current);
          setEarlier((list) => {
            const rest = list.filter((_, at) => at !== index);
            /* Gone entries are dropped; a successful return files the current one. */
            return kept ? [...rest, current] : rest;
          });
        },
        onError: (error) => setNotice(messageOf(error)),
      },
    );
  }

  return {
    begin,
    suggestAnother,
    returnTo,
    earlier: earlier.map((preview) => ({
      key: proposalOf(preview).accountId ?? "",
      label: preview.replacement?.account.email ?? "",
    })),
    isSearching: search.isPending,
    notice,
  } as const;
}
