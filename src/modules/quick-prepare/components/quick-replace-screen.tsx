"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { RefreshCcw, Search, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { ActionError } from "@/lib/errors";
import { formatPhoneForDisplay } from "@/lib/phone";
import { FormField } from "@/shared/forms/form-field";
import { Button } from "@/shared/ui/button";
import {
  PROBLEM_TYPE_LABELS,
  ProblemSeverityBadgeBase,
  ProblemStatusBadgeBase,
} from "@/shared/ui/problem-badges";
import {
  PROFILE_STATE_LABELS,
  PROFILE_STATE_STYLES,
  ProfileStateLegend,
  type ProfileSlotState,
} from "@/shared/ui/profile-state";
import { cn } from "@/utils/cn";
import { useConfirmReplacement, usePreviewReplacement } from "../hooks/use-quick-prepare";
import { CredentialResult } from "./credential-result";
import type { PreparationResult } from "../services/quick-prepare.service";
import type {
  AccountProfileSlot,
  ReplacementCandidate,
  ReplacementPreview,
} from "../services/quick-replace.service";

/**
 * Quick Replace — M13 §9.
 *
 * An account has gone bad and a customer is sitting on it. The operator types
 * the account email the customer was given, sees the whole picture, and only
 * then decides. This screen is the "sees the whole picture" half.
 *
 * NOTHING HERE DECIDES ANYTHING.
 *
 * Every state on this screen was derived on the server: which slots are
 * sellable, which allocations have lapsed, how many days a customer has left,
 * which account is offered as a replacement, whether its password must be
 * changed first. The client renders that and computes none of it — M13 §11
 * requires one interpretation of these rules, and a second one written in React
 * would be a second source of truth that drifts silently.
 *
 * `profiles.status` is deliberately never read here. It says `sold` for
 * allocations that lapsed months ago, because nothing writes `expired`. The
 * server's `profileCellState` is authoritative and this component takes it as
 * given.
 *
 * The preview is READ-ONLY. It takes no locks and writes nothing, so an operator
 * can look something up, walk away, and cost the business nothing.
 */

/*
 * Mirrors `replaceLookupSchema`'s email rule for the one field this form
 * collects.
 *
 * `replaceLookupSchema` itself cannot be imported here, and the reason is
 * structural rather than stylistic: it imports `PROFILES_PER_ACCOUNT` from the
 * accounts barrel, which re-exports `server-only` services. Pulling that into a
 * Client Component is a build error. `QuickPrepareWizard` declares its own form
 * schema for exactly the same reason — this follows the established pattern
 * rather than inventing one.
 *
 * The server's schema remains the authority. It validates the same field again
 * on every lookup, and its refusal renders on this input. This copy exists so a
 * typo costs no round trip; it is not the check that matters.
 */
const lookupFormSchema = z.object({
  accountEmail: z
    .string()
    .trim()
    .min(1, "Enter the account email the customer is using")
    .email("Enter a valid email address"),
});

type LookupForm = z.infer<typeof lookupFormSchema>;

/** One slot, rendered in the shared four-state vocabulary. */
function SlotCell({ slot }: { slot: AccountProfileSlot }) {
  const state: ProfileSlotState = slot.state;

  return (
    <li
      className={
        "flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 " +
        PROFILE_STATE_STYLES[state]
      }
    >
      <span className="flex items-center gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded border border-current/30 text-caption font-medium tabular-nums">
          {slot.profile.profileNumber}
        </span>
        <span className="text-caption font-medium">{PROFILE_STATE_LABELS[state]}</span>
      </span>

      <span className="text-caption opacity-80">
        {/*
          The holder, when there is one. `customerName` comes from the server's
          LEFT JOIN — a free slot has none, and that absence is the signal.
        */}
        {slot.customerName ?? (state === "not_for_sale" ? "not stock" : "unallocated")}
      </span>
    </li>
  );
}

/** The account and every physical slot on it. M13 §9 step 3. */
function AccountPanel({ preview }: { preview: ReplacementPreview }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-card-title text-foreground">{preview.oldAccount.email}</h2>
        <p className="text-caption text-foreground-muted">
          {preview.accountProfiles.length} profile
          {preview.accountProfiles.length === 1 ? "" : "s"} · {preview.oldAccount.profileSlots}{" "}
          sellable · {preview.candidates.length} customer
          {preview.candidates.length === 1 ? "" : "s"}
        </p>
      </header>

      <ul className="flex flex-col gap-2">
        {preview.accountProfiles.map((slot) => (
          <SlotCell key={slot.profile.id} slot={slot} />
        ))}
      </ul>

      <ProfileStateLegend />
    </section>
  );
}

/**
 * Who holds what, when the account carries more than one customer.
 *
 * M13 §9 is explicit that this must be asked rather than guessed, and the server
 * enforces it: `preview.selected` comes back null whenever the account has
 * several customers and the request named none. Replacing the wrong customer's
 * profile cannot be undone by pressing back.
 *
 * Selecting re-runs the SERVER preview with `customerId`. The chosen candidate
 * is not promoted client-side — the second response is the source of truth, and
 * it is the one that decides which profiles are held and how many days remain.
 */
function CustomerChooser({
  candidates,
  onSelect,
  disabled,
  selectedId,
}: {
  candidates: ReplacementPreview["candidates"];
  onSelect: (customerId: string) => void;
  disabled: boolean;
  selectedId: string | null;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-card-title text-foreground">Which customer?</h2>
        <p className="text-caption text-foreground-muted">
          {candidates.length} customers hold profiles on this account. Choose the one being moved.
        </p>
      </header>

      <ul className="flex flex-col gap-2">
        {candidates.map((candidate) => {
          const isSelected = candidate.customer.id === selectedId;

          return (
            <li key={candidate.customer.id}>
              <button
                type="button"
                onClick={() => onSelect(candidate.customer.id)}
                disabled={disabled}
                aria-pressed={isSelected}
                className={cn(
                  "flex w-full flex-col gap-2 rounded-md border p-3 text-left transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  isSelected
                    ? "border-primary bg-primary-subtle"
                    : "border-border bg-background-secondary hover:border-primary/40",
                )}
              >
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-description font-medium text-foreground">
                    {candidate.customer.name ?? "Unnamed customer"}
                  </span>
                  <span className="text-caption text-foreground-muted tabular-nums">
                    {formatPhoneForDisplay(candidate.customer.phoneNormalized)}
                  </span>
                </span>

                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-foreground-muted">
                  <span>
                    Profile{candidate.profiles.length === 1 ? "" : "s"}{" "}
                    {candidate.profiles.map((profile) => profile.profileNumber).join(", ")}
                  </span>

                  <span aria-hidden="true">·</span>

                  {/*
                    `remainingDays` and `hasExpired` are both server-derived.
                    An expired allocation cannot be replaced — there is nothing
                    left to carry over — and saying so here saves the operator a
                    refusal they would otherwise meet at confirmation.
                  */}
                  {candidate.hasExpired ? (
                    <span className="text-danger">expired — nothing to carry over</span>
                  ) : (
                    <span>
                      {candidate.remainingDays} day
                      {candidate.remainingDays === 1 ? "" : "s"} remaining
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The customer the server resolved, once there is exactly one. */
function SelectedCustomerPanel({ selected }: { selected: ReplacementCandidate }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary-subtle p-5">
      <h2 className="text-card-title text-foreground">
        {selected.customer.name ?? "Unnamed customer"}
      </h2>

      <dl className="flex flex-col gap-1.5 text-caption">
        <div className="flex justify-between gap-3">
          <dt className="text-foreground-muted">Phone</dt>
          <dd className="text-foreground tabular-nums">
            {formatPhoneForDisplay(selected.customer.phoneNormalized)}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-foreground-muted">
            Holds profile{selected.profiles.length === 1 ? "" : "s"}
          </dt>
          <dd className="text-foreground tabular-nums">
            {selected.profiles.map((profile) => profile.profileNumber).join(", ")}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-foreground-muted">Remaining</dt>
          <dd
            className={cn("tabular-nums", selected.hasExpired ? "text-danger" : "text-foreground")}
          >
            {selected.hasExpired
              ? "expired"
              : `${selected.remainingDays} day${selected.remainingDays === 1 ? "" : "s"}`}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * Active problems on the failing account. M13 §9 step 5.
 *
 * The list arrives already filtered and ordered by
 * `problemsService.activeForAccount`, which uses `BLOCKING_STATUSES` — open,
 * in_progress and waiting. This renders that list as given: no re-filtering, no
 * re-sorting, no second opinion about which statuses count. Problems are
 * account-level in this data model (`issues.accountId`, with no profile column),
 * and this panel is account-level to match.
 */
function ProblemsPanel({ problems }: { problems: ReplacementPreview["problems"] }) {
  if (problems.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-surface p-5">
      <header className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="flex flex-col gap-0.5">
          <h2 className="text-card-title text-foreground">
            {problems.length} open problem{problems.length === 1 ? "" : "s"} on this account
          </h2>
          <p className="text-caption text-foreground-muted">
            Recorded against the account, newest first.
          </p>
        </div>
      </header>

      <ul className="flex flex-col gap-2">
        {problems.map((problem) => (
          <li
            key={problem.id}
            className="flex flex-col gap-2 rounded-md bg-background-secondary p-3"
          >
            <span className="flex flex-wrap items-center gap-2">
              <ProblemStatusBadgeBase status={problem.status} />
              <ProblemSeverityBadgeBase severity={problem.severity} />
              <span className="text-caption text-foreground-muted">
                {PROBLEM_TYPE_LABELS[problem.issueType] ?? problem.issueType}
              </span>
            </span>

            <p className="text-caption text-foreground">{problem.description}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Why no replacement could be offered.
 *
 * Every reason here is the server's. `blockedReason` distinguishes "there is no
 * stock" from "there is stock, but none of it lasts long enough" — two problems
 * with completely different answers, and collapsing them into "unavailable"
 * would hide the second behind the first.
 */
function BlockedPanel({ preview }: { preview: ReplacementPreview }) {
  const needed = preview.selected?.remainingDays ?? 0;
  const best = preview.bestAvailableDays;

  const message =
    preview.blockedReason === "nothing_to_replace"
      ? "Nobody holds a profile on this account, so there is nothing to replace."
      : preview.blockedReason === "no_stock"
        ? "No healthy account has a free profile right now."
        : preview.blockedReason === "insufficient_validity"
          ? best === null
            ? `No account has enough validity left to cover the remaining ${needed} days.`
            : `The best available account has ${best} day${best === 1 ? "" : "s"} left, and this customer needs ${needed}.`
          : preview.selected?.hasExpired
            ? "This customer's subscription has already expired, so there is nothing to carry over. Prepare a new subscription instead."
            : "No replacement could be offered for this customer.";

  return (
    <section className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-subtle p-4">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <p className="text-caption text-warning">{message}</p>
    </section>
  );
}

/**
 * The proposed move. M13 §9 steps 8-10.
 *
 * The rule this panel exists to make visible is the carry-over: a replacement
 * preserves the days the customer has LEFT, and never restarts the term they
 * originally bought. 90 bought, 40 consumed, 50 carried — the expiry date does
 * not move.
 *
 * Both numbers are the server's. `remainingDays` is what the replacement account
 * must cover, and `expirationDate` is the customer's existing expiry carried
 * across verbatim. The original `durationDays` is deliberately not shown
 * anywhere on this panel: it is the number an operator would reach for by
 * mistake, and it is not the number that governs.
 */
function ReplacementPanel({
  preview,
  selected,
}: {
  preview: ReplacementPreview;
  selected: ReplacementCandidate;
}) {
  const replacement = preview.replacement;

  if (!replacement) {
    return null;
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-primary/40 bg-surface p-5">
      <header className="flex flex-col gap-1">
        <span className="w-fit rounded-md bg-primary-subtle px-2 py-0.5 text-caption font-medium text-primary">
          Preview — nothing has changed yet
        </span>
        <h2 className="text-card-title text-foreground">Proposed replacement</h2>
      </header>

      <dl className="flex flex-col gap-2 text-caption">
        <div className="flex flex-wrap justify-between gap-3">
          <dt className="text-foreground-muted">Moving from</dt>
          <dd className="text-foreground">
            {preview.oldAccount.email} · profile
            {selected.profiles.length === 1 ? "" : "s"}{" "}
            {selected.profiles.map((profile) => profile.profileNumber).join(", ")}
          </dd>
        </div>

        <div className="flex flex-wrap justify-between gap-3">
          <dt className="text-foreground-muted">Moving to</dt>
          <dd className="text-foreground">
            {replacement.account.email} · profile
            {replacement.profiles.length === 1 ? "" : "s"}{" "}
            {replacement.profiles.map((profile) => profile.profileNumber).join(", ")}
          </dd>
        </div>

        <div className="flex flex-wrap justify-between gap-3">
          <dt className="text-foreground-muted">Sellable capacity there</dt>
          <dd className="text-foreground tabular-nums">
            {replacement.account.profileSlots} slot
            {replacement.account.profileSlots === 1 ? "" : "s"}
          </dd>
        </div>

        <div className="flex flex-wrap justify-between gap-3">
          <dt className="text-foreground-muted">That account&rsquo;s validity</dt>
          <dd className="text-foreground tabular-nums">
            {replacement.remainingValidityDays === null
              ? "Open-ended"
              : `${replacement.remainingValidityDays} days`}
          </dd>
        </div>
      </dl>

      {/*
        The carry-over, stated rather than implied. This is the rule M13 §9
        singles out, and the one an operator most needs to trust.
      */}
      <div className="flex flex-col gap-1 rounded-md bg-background-secondary p-3">
        <p className="text-caption text-foreground">
          The customer keeps their remaining{" "}
          <span className="font-medium tabular-nums">
            {selected.remainingDays} day{selected.remainingDays === 1 ? "" : "s"}
          </span>
          {replacement.expirationDate ? (
            <>
              , expiring{" "}
              <span className="font-medium tabular-nums">{replacement.expirationDate}</span>
            </>
          ) : null}
          .
        </p>
        <p className="text-caption text-foreground-subtle">
          The clock is not restarted — the original expiry date moves across unchanged.
        </p>
      </div>
    </section>
  );
}

export function QuickReplaceScreen() {
  const [preview, setPreview] = useState<ReplacementPreview | null>(null);
  /* The email the current preview belongs to, so a selection can re-query it. */
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /* M13 §8. Reset whenever a new preview arrives, so it is never carried over. */
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [result, setResult] = useState<PreparationResult | null>(null);

  const lookup = usePreviewReplacement();
  const confirm = useConfirmReplacement();

  const form = useForm<LookupForm>({
    resolver: zodResolver(lookupFormSchema),
    defaultValues: { accountEmail: "" },
  });

  /*
   * A server refusal that names a field renders ON that field. The account
   * lookup fails with `fieldErrors.accountEmail` precisely so "no account with
   * that email" appears under the input the operator typed, rather than in a
   * toast that disappears.
   */
  const serverFieldError =
    lookup.error instanceof ActionError ? lookup.error.fieldErrors?.["accountEmail"] : undefined;

  function onSubmit(values: LookupForm) {
    setPreview(null);
    setSelectedId(null);
    setPasswordChanged(false);
    setResult(null);
    setAccountEmail(values.accountEmail);
    confirm.reset();

    lookup.mutate({ accountEmail: values.accountEmail }, { onSuccess: setPreview });
  }

  function startOver() {
    setPreview(null);
    setSelectedId(null);
    setPasswordChanged(false);
    setResult(null);
    setAccountEmail(null);
    lookup.reset();
    confirm.reset();
  }

  /**
   * Commits the replacement the operator approved.
   *
   * Every field here comes from the preview the server produced, and every one
   * of them is re-verified server-side under lock:
   *
   *   replacementAccountId  must still be the eligible account it approved
   *   expectedProfileIds    must still be what the customer holds
   *   passwordChangeConfirmed  is permission, never evidence — the requirement
   *                            itself is re-derived from the locked account
   *
   * The UI reimplements none of that. It carries the identifiers and lets the
   * transaction refuse.
   */
  function submitConfirmation(selected: ReplacementCandidate, replacementAccountId: string) {
    if (!preview) {
      return;
    }

    confirm.mutate(
      {
        accountId: preview.oldAccount.id,
        customerId: selected.customer.id,
        expectedProfileIds: selected.profiles.map((profile) => profile.id),
        replacementAccountId,
        reason: preview.oldAccount.status,
        passwordChangeConfirmed: passwordChanged,
      },
      { onSuccess: setResult },
    );
  }

  /**
   * Re-runs the preview for one customer.
   *
   * Deliberately a second server call rather than picking the candidate out of
   * the response already in hand. The server decides what `selected` means, and
   * on the next slice that same call is what produces the proposed replacement
   * and the password-change requirement for THIS customer. Resolving it locally
   * would work today and be a second source of truth tomorrow.
   */
  function chooseCustomer(customerId: string) {
    if (accountEmail === null) {
      return;
    }

    setSelectedId(customerId);
    /* A fresh preview means a fresh decision about the password. */
    setPasswordChanged(false);
    confirm.reset();

    lookup.mutate({ accountEmail, customerId }, { onSuccess: setPreview });
  }

  /*
   * The credentials exist only here, and only because the transaction committed.
   * Rendering the result INSTEAD of the review screen — rather than beneath it —
   * means a failed confirmation can never sit next to a success.
   */
  if (result) {
    return (
      <CredentialResult
        result={result}
        title="Replaced"
        restartLabel="Look up another"
        onStartOver={startOver}
      />
    );
  }

  /*
   * Narrowed once, as consts, so the confirm callback closes over values
   * TypeScript already knows are present. Reading `preview.selected` inside the
   * handler would need a non-null assertion, and an assertion is exactly the
   * kind of "trust me" this codebase has been bitten by before.
   */
  const selectedCandidate: ReplacementCandidate | null = preview?.selected ?? null;
  const replacementAccountId: string | null = preview?.replacement?.account.id ?? null;

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={form.handleSubmit(onSubmit)}
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
          error={form.formState.errors.accountEmail?.message ?? serverFieldError}
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
          <AccountPanel preview={preview} />

          {/* Account-level, so it is shown whatever the customer state is. */}
          <ProblemsPanel problems={preview.problems} />

          {preview.blockedReason === "nothing_to_replace" ? (
            <BlockedPanel preview={preview} />
          ) : selectedCandidate ? (
            /*
             * Resolved by the server — either the account carries one customer,
             * or the operator chose. Both arrive the same way, so there is one
             * rendering path rather than a "convenient" second one.
             */
            <>
              <SelectedCustomerPanel selected={selectedCandidate} />

              {replacementAccountId ? (
                <>
                  <ReplacementPanel preview={preview} selected={selectedCandidate} />

                  <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
                    {/*
                      M13 §7 and §8. Shown only when the SERVER says this
                      replacement account previously served a customer whose
                      subscription lapsed — that person still knows the password.
                      The requirement is never computed here.
                    */}
                    {preview.requiresPasswordChange ? (
                      <div className="flex flex-col gap-3">
                        <div
                          role="alert"
                          className="flex items-start gap-3 rounded-md border border-warning/40 bg-warning-subtle p-4"
                        >
                          <TriangleAlert
                            className="mt-0.5 size-4 shrink-0 text-warning"
                            aria-hidden="true"
                          />
                          <p className="text-caption text-foreground-muted">
                            <span className="text-foreground">
                              This account previously belonged to another customer.
                            </span>{" "}
                            Change the Netflix password and confirm you have done so before handing
                            it over.
                          </p>
                        </div>

                        <label className="flex cursor-pointer items-start gap-2.5 rounded-md bg-background-secondary p-3">
                          <input
                            type="checkbox"
                            checked={passwordChanged}
                            disabled={confirm.isPending}
                            onChange={(event) => setPasswordChanged(event.target.checked)}
                            className="mt-0.5 size-4 shrink-0 accent-primary"
                          />
                          <span className="text-caption text-foreground">
                            I have changed the Netflix password on this account.
                          </span>
                        </label>
                      </div>
                    ) : null}

                    {/*
                      A refusal the server returned. Rendered next to the button
                      that caused it, and never replaced by a success screen.
                    */}
                    {confirm.error ? (
                      <p role="alert" className="text-caption text-danger">
                        {confirm.error instanceof ActionError
                          ? confirm.error.userMessage
                          : "Could not replace. Look the customer up again."}
                      </p>
                    ) : null}

                    <div className="flex items-center justify-end">
                      <Button
                        onClick={() => submitConfirmation(selectedCandidate, replacementAccountId)}
                        loading={confirm.isPending}
                        loadingLabel="Replacing"
                        /* The password gate is a precondition, not a pending request. */
                        disabled={
                          confirm.isPending || (preview.requiresPasswordChange && !passwordChanged)
                        }
                        className="min-w-48 gap-2"
                      >
                        <RefreshCcw className="size-4" aria-hidden="true" />
                        Confirm replacement
                      </Button>
                    </div>
                  </section>
                </>
              ) : (
                <BlockedPanel preview={preview} />
              )}
            </>
          ) : preview.candidates.length > 0 ? (
            <CustomerChooser
              candidates={preview.candidates}
              onSelect={chooseCustomer}
              disabled={lookup.isPending}
              selectedId={selectedId}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
