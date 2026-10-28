"use client";

import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { toast } from "sonner";

import { ActionError } from "@/lib/errors";
import {
  confirmRenewalAction,
  listRenewProfilesAction,
  previewRenewalAction,
  searchRenewAccountsAction,
  type RenewActionResult,
} from "../actions/quick-renew.actions";

/** Unwraps a Server Action result into the value, or throws a renderable error. */
function unwrap<T>(result: RenewActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

export function useAccountSearch() {
  return useMutation({
    mutationFn: async (input: { email: string }) => unwrap(await searchRenewAccountsAction(input)),
    onError: (error) => {
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not search", { description: error.userMessage });
      }
    },
  });
}

export function useAccountProfiles() {
  return useMutation({
    mutationFn: async (accountId: string) => unwrap(await listRenewProfilesAction(accountId)),
    onError: (error) => toast.error("Could not load profiles", { description: error.userMessage }),
  });
}

export function useRenewalPreview() {
  return useMutation({
    mutationFn: async (input: unknown) => unwrap(await previewRenewalAction(input)),
  });
}

export function useConfirmRenewal() {
  return useMutation({
    mutationFn: async (input: unknown) => unwrap(await confirmRenewalAction(input)),
    onSuccess: (data) => {
      if (data.replayed) {
        toast.info("Already renewed", {
          description: "This renewal was already applied — showing its result again.",
        });
        return;
      }

      toast.success("Subscription renewed", {
        description: `New expiry ${data.newExpirationDate}.`,
      });
    },
    onError: (error) => {
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not renew", { description: error.userMessage });
      }
    },
  });
}

/**
 * One operation id per thing being renewed (M08 convention).
 *
 * Returns the same id while `identity` — the profile and the period the
 * operator approved — stays the same, and a new one when it changes. Every
 * attempt at the same renewal therefore carries the same id, so a retry after a
 * lost response replays the first result instead of adding the period twice.
 */
export function useRenewalOperationId(): (identity: string) => string {
  const current = useRef<{ identity: string; id: string } | null>(null);

  return useCallback((identity: string) => {
    if (current.current?.identity !== identity) {
      current.current = { identity, id: crypto.randomUUID() };
    }

    return current.current.id;
  }, []);
}
