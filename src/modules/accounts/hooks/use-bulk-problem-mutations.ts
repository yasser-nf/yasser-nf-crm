"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ActionError } from "@/lib/errors";
import type { BulkOutcome } from "@/utils/bulk";
import {
  declareProblemsForAccountsAction,
  resolveProblemsForAccountsAction,
  type ActionResult,
} from "../actions/account.actions";

/**
 * Bulk problem mutations for the accounts list.
 *
 * The same shape as use-account-mutations: the Result-to-exception conversion
 * happens at the hook boundary, and `unwrapAction` restores the error's
 * identity so a component reads `userMessage` rather than undefined.
 */

function unwrapAction<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

interface BulkProblemInput {
  readonly ids: readonly string[];
  readonly input: unknown;
}

/**
 * Reports the outcome honestly.
 *
 * A partial failure is a warning, never a green toast: the accounts that were
 * acted on are changed either way, and hiding the refusals would misreport what
 * happened. A single refusal shows its own message, which is the one that
 * explains why — "not assigned to you", or "no open problem to resolve".
 */
function announce(outcome: BulkOutcome, verb: string): void {
  const total = outcome.succeeded.length + outcome.failed.length;

  if (outcome.failed.length === 0) {
    toast.success(
      `${outcome.succeeded.length} account${outcome.succeeded.length === 1 ? "" : "s"} ${verb}`,
    );
    return;
  }

  toast.warning(`${outcome.succeeded.length} of ${total} ${verb}`, {
    description:
      outcome.failed.length === 1 && outcome.failed[0]
        ? outcome.failed[0].message
        : `${outcome.failed.length} accounts could not be updated.`,
  });
}

export function useDeclareProblems() {
  const router = useRouter();

  return useMutation({
    mutationFn: async ({ ids, input }: BulkProblemInput) =>
      unwrapAction(await declareProblemsForAccountsAction([...ids], input)),
    onSuccess: (outcome) => {
      announce(outcome, "updated");
      router.refresh();
    },
    onError: (error) =>
      toast.error("Could not declare the problem", { description: error.userMessage }),
  });
}

export function useResolveProblems() {
  const router = useRouter();

  return useMutation({
    mutationFn: async ({ ids, input }: BulkProblemInput) =>
      unwrapAction(await resolveProblemsForAccountsAction([...ids], input)),
    onSuccess: (outcome) => {
      announce(outcome, "resolved");
      router.refresh();
    },
    onError: (error) => toast.error("Could not resolve", { description: error.userMessage }),
  });
}
