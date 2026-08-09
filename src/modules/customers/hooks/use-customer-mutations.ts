"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ActionError } from "@/lib/errors";
import {
  archiveCustomerAction,
  setCustomerBlockedAction,
  updateCustomerNotesAction,
  type ActionResult,
} from "../actions/customer.actions";

/**
 * Customer mutation hooks.
 *
 * ADR-003 puts the Result-to-exception conversion at the hook boundary.
 * `unwrapAction` also restores the error's identity from the action's
 * serialisable envelope, so components and the retry policy see the same shape
 * they would from a local service call.
 */

function unwrapAction<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

export function useUpdateNotes(customerId: string) {
  const router = useRouter();

  return useMutation({
    mutationFn: async (notes: string) =>
      unwrapAction(await updateCustomerNotesAction(customerId, notes)),
    onSuccess: () => {
      toast.success("Notes saved");
      router.refresh();
    },
    onError: (error) => {
      /* Field errors render on the textarea; only the rest need a toast. */
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not save notes", { description: error.userMessage });
      }
    },
  });
}

export function useSetBlocked(customerId: string) {
  const router = useRouter();

  return useMutation({
    mutationFn: async (blocked: boolean) =>
      unwrapAction(await setCustomerBlockedAction(customerId, blocked)),
    onSuccess: (customer) => {
      toast.success(customer.blockedAt ? "Customer blocked" : "Customer unblocked");
      router.refresh();
    },
    onError: (error) =>
      toast.error("Could not change block status", { description: error.userMessage }),
  });
}

export function useArchiveCustomer(customerId: string) {
  return useMutation({
    mutationFn: async () => unwrapAction(await archiveCustomerAction(customerId)),
    onError: (error) => toast.error("Could not archive", { description: error.userMessage }),
  });
}
