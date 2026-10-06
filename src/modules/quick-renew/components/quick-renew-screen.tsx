"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CalendarPlus, Search } from "lucide-react";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { ActionError } from "@/lib/errors";
import { Button } from "@/shared/ui/button";
import { FormField } from "@/shared/forms/form-field";
import {
  renewalIdentity,
  useConfirmRenewal,
  usePreviewRenewal,
  useQuoteRenewal,
  useRenewalOperationId,
} from "../hooks/use-quick-renew";
import type { RenewalDuration } from "../services/renewal-duration";
import type { RenewalResult } from "../services/quick-renew.service";
import type { RenewalPreview, RenewalQuoteResult } from "../services/renewal-lookup.service";
import { AccountPanel, ProblemsPanel, ReviewPanel, SubscriptionPanel } from "./renewal-panels";
import { RenewalDurationPicker } from "./renewal-duration-picker";
import { RenewalResultPanel } from "./renewal-result";

/**
 * Quick Renew. M09 §4 and §15.
 *
 *   email → account → profile → customer & subscription → duration → preview → confirm
 *
 * NOTHING HERE DECIDES ANYTHING.
 *
 * Which slots are renewable, why one is not, how many days are left, what the
 * new expiry would be — every one of those arrives from the server, derived by
 * the same functions the commit uses. The client carries identifiers and
 * renders answers. M09 §22 and §24: one interpretation of these rules, not a
 * second written in React that drifts.
 *
 * `profiles.status` is deliberately never read here. It says `sold` for
 * allocations that lapsed months ago, because nothing writes `expired`
 * (ADR-013 D2). The server's `profileCellState` is authoritative.
 *
 * The first two steps are READ-ONLY. An operator can look an account up, quote
 * three durations and walk away, and nothing has been written or locked.
 */

/*
 * Mirrors `renewLookupSchema`'s one field.
 *
 * That schema cannot be imported here: it reaches the quick-prepare barrel for
 * the shared duration bounds, and that barrel re-exports `server-only`
 * services, which is a build error in a Client Component. `QuickPrepareWizard`
 * and `QuickReplaceScreen` declare their own form schemas for exactly the same
 * reason. The server validates again and its refusal renders on this input.
 */
const lookupFormSchema = z.object({
  accountEmail: z
    .string()
    .trim()
    .min(1, "Enter the account email the customer is using")
    .email("Enter a valid email address"),
});

type LookupForm = z.infer<typeof lookupFormSchema>;

export function QuickRenewScreen() {
  const [preview, setPreview] = useState<RenewalPreview | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [duration, setDuration] = useState<RenewalDuration | null>(null);
  const [customText, setCustomText] = useState("");
  const [quote, setQuote] = useState<RenewalQuoteResult | null>(null);
  const [result, setResult] = useState<RenewalResult | null>(null);

  const lookup = usePreviewRenewal();
  const quoting = useQuoteRenewal();
  const confirm = useConfirmRenewal();
  const operationIdFor = useRenewalOperationId();

  /** Latched for the duration of one confirmation. See `submitConfirmation`. */
  const inFlight = useRef(false);

  const form = useForm<LookupForm>({
    resolver: zodResolver(lookupFormSchema),
    defaultValues: { accountEmail: "" },
  });

  const lookupFieldError =
    lookup.error instanceof ActionError ? lookup.error.fieldErrors?.["accountEmail"] : undefined;

  /* A refusal about the duration renders on the custom-days input. */
  const durationFieldError =
    quoting.error instanceof ActionError ? quoting.error.fieldErrors?.["days"] : undefined;

  const selected = preview?.profiles.find((entry) => entry.profile.id === selectedId) ?? null;

  function resetFromProfile() {
    setDuration(null);
    setCustomText("");
    setQuote(null);
    quoting.reset();
    confirm.reset();
  }

  function onLookup(values: LookupForm) {
    setPreview(null);
    setSelectedId(null);
    setResult(null);
    resetFromProfile();

    lookup.mutate({ accountEmail: values.accountEmail }, { onSuccess: setPreview });
  }

  function startOver() {
    setPreview(null);
    setSelectedId(null);
    setResult(null);
    resetFromProfile();
    lookup.reset();
    form.reset();
  }

  function chooseProfile(profileId: string) {
    setSelectedId(profileId);
    resetFromProfile();
  }

  /**
   * Quotes a duration on the SERVER.
   *
   * Deliberately a round trip rather than arithmetic in the browser. The quote
   * has to apply the account's own validity — a renewal may not outlive the
   * account carrying it (M13 §1) — and that rule needs the account row. A quote
   * that passed here and failed at confirmation would be worse than none: the
   * operator would already have named the date to the customer.
   */
  function chooseDuration(next: RenewalDuration | null) {
    setDuration(next);
    setQuote(null);
    quoting.reset();
    confirm.reset();

    if (next === null || selectedId === null) {
      return;
    }

    quoting.mutate({ profileId: selectedId, duration: next }, { onSuccess: setQuote });
  }

  /**
   * Commits the renewal the operator approved.
   *
   * `expectedExpirationDate` is the precondition that makes this safe under
   * concurrency: it is the expiry the operator was SHOWN, and the transaction
   * refuses if the locked row no longer carries it. Two operators who both
   * opened this profile therefore cannot both extend it — the second is told it
   * changed, rather than silently adding to the first's renewal.
   */
  function submitConfirmation() {
    if (!quote || !selected || !duration || !preview) {
      return;
    }

    /*
     * Narrowed rather than coalesced. A quote only exists for a renewable
     * profile and a renewable profile has a linked customer — but the commit
     * REQUIRES the customer id as a precondition, and sending `undefined`
     * would turn an impossible state into a validation error nobody can act
     * on. Returning says what is true: there is nothing to renew.
     */
    if (quote.customer.kind !== "linked") {
      return;
    }

    /*
     * Two taps must not become two renewals.
     *
     * `confirm.isPending` already disables the button, but only after React
     * re-renders — a fast double tap can land both clicks in the same frame.
     * This ref flips synchronously inside the handler, so the second call
     * returns before reaching the action.
     *
     * The server does not rely on it: the operation id below makes a repeat of
     * this renewal replay the first result (M08 jobs), and the row is locked
     * FOR UPDATE. This is the cheap guard in front of both.
     */
    if (inFlight.current) {
      return;
    }

    inFlight.current = true;

    const expectedExpirationDate = quote.quote.previousExpirationDate;

    confirm.mutate(
      {
        profileId: quote.profileId,
        accountId: quote.accountId,
        customerId: quote.customer.customer.id,
        expectedExpirationDate,
        duration,
        operationId: operationIdFor(
          renewalIdentity({
            profileId: quote.profileId,
            expectedExpirationDate,
            duration: JSON.stringify(duration),
          }),
        ),
      },
      {
        onSuccess: (data) => {
          inFlight.current = false;
          setResult(data);
        },
        /* Released, so an operator can retry after a refusal they have fixed. */
        onError: () => {
          inFlight.current = false;
        },
      },
    );
  }

  /*
   * The result replaces the review rather than joining it, so a refusal can
   * never sit beside a success.
   */
  if (result) {
    return <RenewalResultPanel result={result} onStartOver={startOver} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={form.handleSubmit(onLookup)}
        className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5"
        noValidate
      >
        <FormField
          label="Account email"
          type="email"
          autoComplete="off"
          placeholder="the address the customer is using"
          hint="The Netflix account email, not the customer's own address."
          disabled={lookup.isPending}
          error={form.formState.errors.accountEmail?.message ?? lookupFieldError}
          {...form.register("accountEmail")}
        />

        <div className="flex justify-end">
          <Button
            type="submit"
            loading={lookup.isPending}
            loadingLabel="Looking up"
            className="min-w-36 gap-2"
          >
            <Search className="size-4" aria-hidden="true" />
            Look up
          </Button>
        </div>
      </form>

      {preview ? (
        <>
          <AccountPanel
            preview={preview}
            selectedId={selectedId}
            disabled={lookup.isPending || confirm.isPending}
            onSelect={chooseProfile}
          />

          <ProblemsPanel problems={preview.problems} />

          {selected ? (
            <>
              <SubscriptionPanel entry={selected} />

              <RenewalDurationPicker
                value={duration}
                onChange={chooseDuration}
                customText={customText}
                onCustomTextChange={setCustomText}
                disabled={quoting.isPending || confirm.isPending}
                error={durationFieldError}
              />

              {/*
                A refusal that names no field — the account's validity, a stale
                quote — shown next to the duration that caused it.
              */}
              {quoting.error instanceof ActionError && !durationFieldError ? (
                <p role="alert" className="text-caption text-danger">
                  {quoting.error.userMessage}
                </p>
              ) : null}

              {quote ? (
                <>
                  <ReviewPanel quote={quote} />

                  <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
                    {confirm.error ? (
                      <p role="alert" className="text-caption text-danger">
                        {confirm.error instanceof ActionError
                          ? confirm.error.userMessage
                          : "Could not renew. Look the account up again."}
                      </p>
                    ) : null}

                    <div className="flex items-center justify-end">
                      <Button
                        onClick={submitConfirmation}
                        loading={confirm.isPending}
                        loadingLabel="Renewing"
                        disabled={confirm.isPending}
                        className="min-w-48 gap-2"
                      >
                        <CalendarPlus className="size-4" aria-hidden="true" />
                        Confirm renewal
                      </Button>
                    </div>
                  </section>
                </>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
