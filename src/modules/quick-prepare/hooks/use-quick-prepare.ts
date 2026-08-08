"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { ActionError } from "@/lib/errors";
import {
  confirmPreparationAction,
  previewAllocationAction,
  replaceAllocationAction,
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

export function usePreviewAllocation() {
  return useMutation({
    mutationFn: async (profileCount: number) =>
      unwrapAction(await previewAllocationAction(profileCount)),
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

export function useReplaceAllocation() {
  return useMutation({
    mutationFn: async (input: unknown) => unwrapAction(await replaceAllocationAction(input)),
    onSuccess: () => {
      toast.success("Replacement allocated", {
        description: "The previous profiles were released and the sale moved.",
      });
    },
    onError: (error) => toast.error("Could not replace", { description: error.userMessage }),
  });
}
