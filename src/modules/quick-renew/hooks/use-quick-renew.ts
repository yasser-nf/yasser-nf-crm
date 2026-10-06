"use client";

import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { toast } from "sonner";

import { ActionError } from "@/lib/errors";
import {
  confirmRenewalAction,
  previewRenewalAction,
  quoteRenewalAction,
  type ActionResult,
} from "../actions/quick-renew.actions";

/**
 * Quick Renew hooks. M09.
 *
 * All three are mutations, including the two read-only steps. A query would be
 * cached and refetched in the background, and an expiry that moved under the
 * operator is exactly what must not be served from a cache — they are about to
 * quote a date to a customer.
 */

function unwrapAction<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

/**
 * M08 jobs: one operation id per thing being confirmed.
 *
 * Returns the same id for as long as `identity` — what the operator approved:
 * this profile, this current expiry, this duration — stays the same, and a new
 * one when any of it changes. Every attempt to confirm the SAME renewal
 * therefore carries the same id, so a retry after a lost response replays the
 * first result instead of renewing twice. Changing the duration is a different
 * renewal and gets a new id.
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

/** What a renewal confirmation is about — the input to `useRenewalOperationId`. */
export function renewalIdentity(input: {
  readonly profileId: string;
  readonly expectedExpirationDate: string | null;
  readonly duration: string;
}): string {
  return [input.profileId, input.expectedExpirationDate ?? "none", input.duration].join(":");
}

/** Step one. Looks up an account by email; writes nothing. */
export function usePreviewRenewal() {
  return useMutation({
    mutationFn: async (input: unknown) => unwrapAction(await previewRenewalAction(input)),
    onError: (error) => {
      /* Field errors render on the input that caused them; only the rest need a toast. */
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not look that up", { description: error.userMessage });
      }
    },
  });
}

/** Step two. Quotes the new expiry; writes nothing. */
export function useQuoteRenewal() {
  return useMutation({
    mutationFn: async (input: unknown) => unwrapAction(await quoteRenewalAction(input)),
    onError: (error) => {
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not quote that renewal", { description: error.userMessage });
      }
    },
  });
}

/** Step three. The only call that writes. */
export function useConfirmRenewal() {
  return useMutation({
    mutationFn: async (input: unknown) => unwrapAction(await confirmRenewalAction(input)),
    onSuccess: (data) => {
      /* M08 jobs: the same renewal confirmed twice. Nothing new was written. */
      if (data.replayed) {
        toast.info("Already renewed", {
          description: "This renewal was already confirmed — showing its result again.",
        });
        return;
      }

      toast.success("Subscription renewed", {
        description: `New expiry ${data.expirationDate}.`,
      });
    },
    onError: (error) => {
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not renew", { description: error.userMessage });
      }
    },
  });
}
