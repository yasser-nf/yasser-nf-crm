"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { ActionError } from "@/lib/errors";
import {
  confirmPreparationAction,
  confirmReplacementAction,
  previewAllocationAction,
  previewReplacementAction,
  type ActionResult,
} from "../actions/quick-prepare.actions";

/**
 * Quick Prepare hooks.
 *
 * All three are mutations, including the preview. A query would be cached and
 * refetched in the background, and stock changes constantly — a cached preview
 * would show a worker an allocation that no longer exists.
 */

function unwrapAction<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

/**
 * Previews an allocation.
 *
 * Takes the whole request, not just the profile count. The earlier version
 * passed only the count, so the preview never applied account validity and
 * could show stock that confirmation then refused. The action validates both
 * fields now, so this cannot regress silently.
 */
export function usePreviewAllocation() {
  return useMutation({
    mutationFn: async (input: { profileCount: number; durationDays: number }) =>
      unwrapAction(await previewAllocationAction(input)),
  });
}

/** Quick Replace step one. Read-only: looks up an allocation, releases nothing. */
export function usePreviewReplacement() {
  return useMutation({
    mutationFn: async (input: unknown) => unwrapAction(await previewReplacementAction(input)),
    onError: (error) => {
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not look that up", { description: error.userMessage });
      }
    },
  });
}

/** Quick Replace step two. Commits only what the operator confirmed. */
export function useConfirmReplacement() {
  return useMutation({
    mutationFn: async (input: unknown) => unwrapAction(await confirmReplacementAction(input)),
    onSuccess: () => {
      toast.success("Replacement allocated", {
        description: "The customer keeps their original expiry date.",
      });
    },
    onError: (error) => {
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not replace", { description: error.userMessage });
      }
    },
  });
}

export function useConfirmPreparation() {
  return useMutation({
    mutationFn: async (input: unknown) => unwrapAction(await confirmPreparationAction(input)),
    onError: (error) => {
      /* Field errors render on the form; only the rest need a toast. */
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not prepare", { description: error.userMessage });
      }
    },
  });
}
