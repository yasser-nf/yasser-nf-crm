"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ROUTES } from "@/config/constants";
import { ActionError } from "@/lib/errors";
import {
  assignSupplierAction,
  createSupplierAction,
  deleteSupplierAction,
  updateSupplierAction,
  type SupplierActionResult,
} from "../actions/suppliers.actions";

/**
 * Supplier mutation hooks (M09B).
 *
 * The same boundary every other module uses: the action's envelope becomes a
 * value or an ActionError here, never in a component.
 *
 * Each success refreshes rather than patching a cache. The Suppliers pages are
 * Server Components, so the counts an operator reads after a write are computed
 * again by PostgreSQL rather than guessed at in the browser. The one cache that
 * is invalidated is the picker's supplier list, which really is client state.
 */

function unwrapAction<T>(result: SupplierActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

export function useCreateSupplier() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: unknown) => unwrapAction(await createSupplierAction(input)),
    onSuccess: (supplier) => {
      void queryClient.invalidateQueries({ queryKey: ["supplier-options"] });
      toast.success("Supplier added", { description: supplier.name });
      router.refresh();
    },
    onError: (error) => {
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not add supplier", { description: error.userMessage });
      }
    },
  });
}

export function useUpdateSupplier(supplierId: string) {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: unknown) =>
      unwrapAction(await updateSupplierAction(supplierId, input)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["supplier-options"] });
      toast.success("Supplier updated");
      router.refresh();
    },
    onError: (error) => {
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not update supplier", { description: error.userMessage });
      }
    },
  });
}

/**
 * Deletes a supplier.
 *
 * The service refuses while accounts still name it and says how many, so that
 * refusal is shown as the message rather than translated into something vaguer.
 */
export function useDeleteSupplier(supplierId: string) {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => unwrapAction(await deleteSupplierAction(supplierId)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["supplier-options"] });
      toast.success("Supplier deleted", {
        description: "The record was kept and marked deleted.",
      });
      router.push(ROUTES.SUPPLIERS);
    },
    onError: (error) =>
      toast.error("Could not delete supplier", { description: error.userMessage }),
  });
}

/** Sets where one account came from. The only write that moves an account between suppliers. */
export function useAssignSupplier() {
  const router = useRouter();

  return useMutation({
    mutationFn: async (input: unknown) => unwrapAction(await assignSupplierAction(input)),
    onSuccess: () => {
      toast.success("Account updated");
      router.refresh();
    },
    onError: (error) => {
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not set the supplier", { description: error.userMessage });
      }
    },
  });
}
