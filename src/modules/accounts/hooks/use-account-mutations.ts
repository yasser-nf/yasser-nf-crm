"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ROUTES } from "@/config/constants";
import { ActionError } from "@/lib/errors";
import {
  archiveAccountAction,
  createAccountAction,
  deleteAccountAction,
  restoreAccountAction,
  revealAccountPasswordAction,
  updateAccountAction,
  unassignSaleAction,
  updateProfileAction,
  type ActionResult,
} from "../actions/account.actions";

/**
 * Account mutation hooks.
 *
 * ADR-003 puts the Result-to-exception conversion at the hook boundary. Here the
 * same conversion also restores the error's identity: `unwrapAction` rebuilds an
 * AppError from the action's serialisable envelope, so components and the retry
 * policy see the same shape they would from a local service call.
 */

/**
 * Turns an action envelope into a value, throwing on failure.
 *
 * The client mirror of `unwrap` in utils/result. Called only inside mutationFn —
 * never in a component.
 */
function unwrapAction<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

export function useCreateAccount() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: unknown) => unwrapAction(await createAccountAction(input)),
    onSuccess: (account) => {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("Account created", {
        description: "Five profiles were created with it.",
      });
      router.push(`${ROUTES.ACCOUNTS}/${account.id}`);
    },
    onError: (error) => {
      /* Field errors render on the form; only non-field failures need a toast. */
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not create account", { description: error.userMessage });
      }
    },
  });
}

export function useUpdateAccount(accountId: string) {
  const router = useRouter();

  return useMutation({
    mutationFn: async (input: unknown) => unwrapAction(await updateAccountAction(accountId, input)),
    onSuccess: () => {
      toast.success("Account updated");
      router.refresh();
    },
    onError: (error) => {
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not update account", { description: error.userMessage });
      }
    },
  });
}

export function useArchiveAccount(accountId: string) {
  const router = useRouter();

  return useMutation({
    mutationFn: async () => unwrapAction(await archiveAccountAction(accountId)),
    onSuccess: () => {
      toast.success("Account archived", {
        description: "Its profiles are no longer available for allocation.",
      });
      router.refresh();
    },
    onError: (error) =>
      toast.error("Could not archive account", { description: error.userMessage }),
  });
}

export function useRestoreAccount(accountId: string) {
  const router = useRouter();

  return useMutation({
    mutationFn: async () => unwrapAction(await restoreAccountAction(accountId)),
    onSuccess: () => {
      toast.success("Account restored", { description: "Status returned to Healthy." });
      router.refresh();
    },
    onError: (error) =>
      toast.error("Could not restore account", { description: error.userMessage }),
  });
}

export function useDeleteAccount(accountId: string) {
  const router = useRouter();

  return useMutation({
    mutationFn: async () => unwrapAction(await deleteAccountAction(accountId)),
    onSuccess: () => {
      toast.success("Account deleted", { description: "The record was kept and marked deleted." });
      router.push(ROUTES.ACCOUNTS);
    },
    onError: (error) => toast.error("Could not delete account", { description: error.userMessage }),
  });
}

/**
 * Reveals the stored password.
 *
 * ADR-006 Decision 4. A mutation rather than a query on purpose: queries are
 * cached and refetched, and a decrypted credential should live only as long as
 * the interaction that asked for it.
 */
export function useRevealPassword(accountId: string) {
  return useMutation({
    mutationFn: async () => unwrapAction(await revealAccountPasswordAction(accountId)),
    onError: (error) =>
      toast.error("Could not reveal password", { description: error.userMessage }),
  });
}

export function useUpdateProfile(accountId: string, profileId: string) {
  const router = useRouter();

  return useMutation({
    mutationFn: async (input: unknown) =>
      unwrapAction(await updateProfileAction(accountId, profileId, input)),
    onSuccess: () => {
      toast.success("Profile updated");
      router.refresh();
    },
    onError: (error) => {
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not update profile", { description: error.userMessage });
      }
    },
  });
}

/**
 * Returns a sold profile to stock.
 *
 * `router.refresh()` rather than a cache invalidation: the account page is a
 * Server Component, so the authoritative numbers — the card, the indicator
 * strip, the sellable tally — are re-rendered on the server from the database
 * the action already revalidated.
 *
 * The conflict case gets its own wording. "No longer sold" is not a failure the
 * operator caused; it means somebody else got there first, and the page they are
 * looking at is simply out of date.
 */
export function useUnassignSale(accountId: string, profileId: string) {
  const router = useRouter();

  return useMutation({
    mutationFn: async () => unwrapAction(await unassignSaleAction(accountId, profileId)),
    onSuccess: () => {
      toast.success("Sale removed", { description: "The profile is available again." });
      router.refresh();
    },
    onError: (error) => {
      toast.error("Could not remove the sale", { description: error.userMessage });
      /* Whatever happened, the server knows the truth about this profile. */
      router.refresh();
    },
  });
}
