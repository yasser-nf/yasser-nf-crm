"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ActionError } from "@/lib/errors";
import {
  createSupplierAction,
  setSupplierActiveAction,
  updateSupplierAction,
  type ActionResult,
} from "../actions/suppliers.actions";

/**
 * Supplier mutation hooks. M10.
 *
 * `router.refresh()` after each success rather than a client-side cache update:
 * the supplier list, the accounts list and the dashboard all derive their
 * figures on the server, and re-rendering them is the only way to keep those
 * figures and this row in step. A locally patched row would show a new name
 * beside stale counts.
 */

function unwrapAction<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

/** Only a failure with no field error needs a toast; the rest render on the form. */
function toastUnlessFieldError(title: string) {
  return (error: unknown) => {
    if (!(error instanceof ActionError) || !error.fieldErrors) {
      toast.error(title, {
        description: error instanceof ActionError ? error.userMessage : undefined,
      });
    }
  };
}

export function useCreateSupplier() {
  const router = useRouter();

  return useMutation({
    mutationFn: async (input: unknown) => unwrapAction(await createSupplierAction(input)),
    onSuccess: (supplier) => {
      toast.success("Supplier created", { description: supplier.name });
      router.refresh();
    },
    onError: toastUnlessFieldError("Could not create the supplier"),
  });
}

export function useUpdateSupplier(id: string) {
  const router = useRouter();

  return useMutation({
    mutationFn: async (input: unknown) => unwrapAction(await updateSupplierAction(id, input)),
    onSuccess: () => {
      toast.success("Supplier updated");
      router.refresh();
    },
    onError: toastUnlessFieldError("Could not update the supplier"),
  });
}

/**
 * Deactivates or reactivates a supplier.
 *
 * The toast says what happened to the accounts, because that is the question an
 * operator has at this moment and M10 §23 answers it: they stay.
 */
export function useSetSupplierActive(id: string) {
  const router = useRouter();

  return useMutation({
    mutationFn: async (active: boolean) => unwrapAction(await setSupplierActiveAction(id, active)),
    onSuccess: (_supplier, active) => {
      toast.success(active ? "Supplier reactivated" : "Supplier deactivated", {
        description: active
          ? "New accounts can be assigned to it again."
          : "Its accounts keep their supplier. No new account can be assigned to it.",
      });
      router.refresh();
    },
    onError: toastUnlessFieldError("Could not change the supplier"),
  });
}
