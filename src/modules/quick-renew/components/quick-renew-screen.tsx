"use client";

import { CalendarPlus, CircleCheck, RefreshCw, Search, TriangleAlert, Users } from "lucide-react";
import { useState } from "react";

import { ActionError } from "@/lib/errors";
import { EmptyState } from "@/shared/feedback/empty-state";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { PROFILE_STATE_LABELS, PROFILE_STATE_STYLES } from "@/shared/ui/profile-state";
import { Skeleton } from "@/shared/ui/skeleton";
import { cn } from "@/utils/cn";
import {
  useAccountProfiles,
  useAccountSearch,
  useConfirmRenewal,
  useRenewalOperationId,
  useRenewalPreview,
} from "../hooks/use-quick-renew";
import { MAX_RENEWAL_DAYS, RENEWAL_MONTH_OPTIONS } from "../services/renewal-dates";
import type {
  AccountProfiles,
  RenewAccountMatch,
  RenewProfileSlot,
  RenewalPreview,
  RenewalResult,
} from "../services/quick-renew.service";

/**
 * Quick Renewing (M09A).
 *
 * Deliberately a different colour from Quick Prepare (primary) and Quick
 * Replace (warning): renewing is additive and routine, so it reads in the
 * success tone, and an operator who meant to replace an account cannot mistake
 * this screen for that one.
 *
 * Every date on screen comes from the server's own preview — the browser never
 * computes an expiry, so what is approved is exactly what is written.
 */

type Duration =
  | { unit: "months"; months: (typeof RENEWAL_MONTH_OPTIONS)[number] }
  | { unit: "days"; days: number };

const MONTH_LABELS: Record<number, string> = {
  1: "1 month",
  2: "2 months",
  3: "3 months",
  6: "6 months",
  12: "1 year",
};

function Section({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-section-title text-foreground">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-raised text-caption text-foreground-muted">
          {step}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function QuickRenewScreen() {
  const [account, setAccount] = useState<RenewAccountMatch | null>(null);
  const [slots, setSlots] = useState<AccountProfiles | null>(null);
  const [slot, setSlot] = useState<RenewProfileSlot | null>(null);
  const [duration, setDuration] = useState<Duration>({ unit: "months", months: 1 });
  const [customDays, setCustomDays] = useState("");
  const [preview, setPreview] = useState<RenewalPreview | null>(null);
  const [result, setResult] = useState<RenewalResult | null>(null);
  const [email, setEmail] = useState("");

  const search = useAccountSearch();
  const profiles = useAccountProfiles();
  const previewRenewal = useRenewalPreview();
  const confirm = useConfirmRenewal();
  const operationIdFor = useRenewalOperationId();

  const searchFieldError =
    search.error instanceof ActionError ? search.error.fieldErrors?.["email"] : undefined;
  const previewMessage =
    previewRenewal.error instanceof Error ? previewRenewal.error.message : null;

  function reset() {
    setAccount(null);
    setSlots(null);
    setSlot(null);
    setPreview(null);
    setResult(null);
    previewRenewal.reset();
    confirm.reset();
  }

  function chooseAccount(match: RenewAccountMatch) {
    setAccount(match);
    setSlot(null);
    setPreview(null);
    setResult(null);
    previewRenewal.reset();
    confirm.reset();
    profiles.mutate(match.account.id, { onSuccess: setSlots });
  }

  function chooseSlot(next: RenewProfileSlot) {
    setSlot(next);
    setPreview(null);
    setResult(null);
    previewRenewal.reset();
    confirm.reset();
    runPreview(next, duration);
  }

  function changeDuration(next: Duration) {
    setDuration(next);
    setPreview(null);
    previewRenewal.reset();
    confirm.reset();

    if (slot) {
      runPreview(slot, next);
    }
  }

  function runPreview(target: RenewProfileSlot, next: Duration) {
    if (!target.renewable) {
      return;
    }

    previewRenewal.mutate(
      { profileId: target.profile.id, duration: next },
      { onSuccess: setPreview },
    );
  }

  function submit() {
    if (!preview || confirm.isPending) {
      return;
    }

    confirm.mutate(
      {
        profileId: preview.profile.id,
        duration,
        expectedExpirationDate: preview.currentExpirationDate,
        operationId: operationIdFor(
          `${preview.profile.id}:${preview.currentExpirationDate}:${JSON.stringify(duration)}`,
        ),
      },
      { onSuccess: setResult },
    );
  }

  if (result) {
    return (
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-3 rounded-lg border border-success/40 bg-success-subtle p-5">
          <h2 className="flex items-center gap-2 text-section-title text-success">
            <CircleCheck className="size-5" aria-hidden="true" />
            {result.replayed ? "Already renewed" : "Subscription renewed"}
          </h2>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Field label="Account">{result.accountEmail}</Field>
            <Field label="Profile">Profile {result.profileNumber}</Field>
            <Field label="Customer">
              {result.customerName ?? "—"}
              <span className="block font-mono text-caption text-foreground-subtle">
                {result.customerPhone}
              </span>
            </Field>
            <Field label="Renewed by">{result.durationLabel}</Field>
            <Field label="Previous expiry">{result.previousExpirationDate}</Field>
            <Field label="New expiry">
              <span className="font-medium text-success">{result.newExpirationDate}</span>
            </Field>
          </dl>
        </section>

        <div>
          <Button onClick={reset} className="gap-2">
            <RefreshCw className="size-4" aria-hidden="true" />
            Renew another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Section step={1} title="Find the account">
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            reset();
            search.mutate({ email });
          }}
        >
          <div className="flex w-full flex-col gap-1.5 sm:max-w-md">
            <Label htmlFor="renew-email">Account email</Label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground-subtle"
                aria-hidden="true"
              />
              <Input
                id="renew-email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                className="h-11 pl-9"
                autoComplete="off"
              />
            </div>
            {searchFieldError ? (
              <p className="text-caption text-danger">{searchFieldError}</p>
            ) : (
              <p className="text-caption text-foreground-subtle">
                Part of the email is enough. Archived and deleted accounts are not shown.
              </p>
            )}
          </div>
          <Button type="submit" loading={search.isPending} className="h-11 sm:w-auto">
            Search
          </Button>
        </form>

        {search.isPending ? <Skeleton className="h-12 w-full" /> : null}

        {search.data && search.data.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No account matches that email"
            description="Check the spelling, or search for a shorter part of the address."
          />
        ) : null}

        {search.data && search.data.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {search.data.map((match) => (
              <li key={match.account.id}>
                <button
                  type="button"
                  onClick={() => chooseAccount(match)}
                  aria-current={account?.account.id === match.account.id}
                  className={cn(
                    "flex w-full flex-col gap-1 rounded-md border px-4 py-3 text-left transition-colors",
                    account?.account.id === match.account.id
                      ? "border-success bg-success-subtle"
                      : "border-border bg-background-secondary hover:bg-surface-raised",
                  )}
                >
                  <span className="text-description break-all text-foreground">
                    {match.account.email}
                  </span>
                  <span className="text-caption text-foreground-muted">
                    {match.account.status}
                    {match.account.country ? ` · ${match.account.country}` : ""}
                    {match.hasBlockingProblem ? " · has an open problem" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {account ? (
        <Section step={2} title="Choose the profile to renew">
          {profiles.isPending ? <Skeleton className="h-24 w-full" /> : null}

          {slots ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {slots.profiles.map((entry) => (
                <button
                  key={entry.profile.id}
                  type="button"
                  disabled={!entry.renewable}
                  onClick={() => chooseSlot(entry)}
                  aria-current={slot?.profile.id === entry.profile.id}
                  className={cn(
                    "flex flex-col gap-1.5 rounded-md border p-3 text-left transition-colors",
                    slot?.profile.id === entry.profile.id
                      ? "border-success bg-success-subtle"
                      : "border-border bg-background-secondary",
                    entry.renewable ? "hover:bg-surface-raised" : "cursor-not-allowed opacity-60",
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-description text-foreground">
                      Profile {entry.profile.profileNumber}
                    </span>
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-caption",
                        PROFILE_STATE_STYLES[entry.state],
                      )}
                    >
                      {PROFILE_STATE_LABELS[entry.state]}
                    </span>
                  </span>

                  {entry.customer ? (
                    <span className="flex flex-col">
                      <span className="text-caption text-foreground">
                        {entry.customer.name ?? "Unnamed customer"}
                      </span>
                      <span className="font-mono text-caption text-foreground-subtle">
                        {entry.customer.phone}
                      </span>
                    </span>
                  ) : (
                    <span className="text-caption text-foreground-subtle">No customer</span>
                  )}

                  <span className="text-caption text-foreground-muted">
                    {entry.profile.expirationDate
                      ? `Expires ${entry.profile.expirationDate}`
                      : "No expiry recorded"}
                  </span>

                  {entry.blockedReason ? (
                    <span className="text-caption text-foreground-subtle">
                      {entry.blockedReason}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          {slots && slots.profiles.every((entry) => !entry.renewable) ? (
            <EmptyState
              icon={Users}
              title="Nothing on this account can be renewed"
              description="A profile can be renewed only while a customer holds it and it has a recorded period."
            />
          ) : null}
        </Section>
      ) : null}

      {slot?.renewable ? (
        <Section step={3} title="Choose how long to add">
          <div className="flex flex-wrap gap-2">
            {RENEWAL_MONTH_OPTIONS.map((months) => (
              <Button
                key={months}
                type="button"
                variant={
                  duration.unit === "months" && duration.months === months ? "default" : "outline"
                }
                size="sm"
                onClick={() => changeDuration({ unit: "months", months })}
              >
                {MONTH_LABELS[months]}
              </Button>
            ))}
          </div>

          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="renew-custom-days">Or a custom number of days</Label>
            <Input
              id="renew-custom-days"
              inputMode="numeric"
              value={customDays}
              placeholder={`1 – ${MAX_RENEWAL_DAYS}`}
              onChange={(event) => {
                const next = event.target.value.replace(/[^0-9]/g, "");
                setCustomDays(next);
                const days = Number(next);

                if (next && Number.isInteger(days) && days >= 1 && days <= MAX_RENEWAL_DAYS) {
                  changeDuration({ unit: "days", days });
                }
              }}
            />
            <p className="text-caption text-foreground-subtle">
              Months are calendar months, not 30-day blocks.
            </p>
          </div>
        </Section>
      ) : null}

      {slot?.renewable ? (
        <Section step={4} title="Review and confirm">
          {previewRenewal.isPending ? <Skeleton className="h-28 w-full" /> : null}

          {previewMessage && !previewRenewal.isPending ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger-subtle px-4 py-3 text-description text-danger"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {previewMessage}
            </p>
          ) : null}

          {preview ? (
            <>
              <dl className="grid gap-3 sm:grid-cols-3">
                <Field label="Current expiry">{preview.currentExpirationDate}</Field>
                <Field label="Adding">{preview.durationLabel}</Field>
                <Field label="New expiry">
                  <span className="text-card-title font-medium text-success">
                    {preview.newExpirationDate}
                  </span>
                </Field>
              </dl>

              <p className="text-caption text-foreground-muted">
                {preview.basis === "continues"
                  ? `Runs on from the current expiry — ${preview.remainingDaysBefore} day${
                      preview.remainingDaysBefore === 1 ? "" : "s"
                    } remaining are kept. ${preview.daysAdded} day${
                      preview.daysAdded === 1 ? "" : "s"
                    } added.`
                  : `Runs from today — ${preview.daysAdded} day${preview.daysAdded === 1 ? "" : "s"} added.`}
              </p>

              {preview.warnings.map((warning) => (
                <p
                  key={warning}
                  className="flex items-start gap-2 rounded-md border border-caution/40 bg-caution-subtle px-4 py-3 text-description text-caution"
                >
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {warning}
                </p>
              ))}

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-caption text-foreground-subtle">
                  Renewing Profile {preview.profile.profileNumber} for{" "}
                  {preview.customer.name ?? preview.customer.phone}. No other profile changes.
                </p>
                <Button
                  onClick={submit}
                  loading={confirm.isPending}
                  disabled={confirm.isPending}
                  className="gap-2 bg-success text-background hover:bg-success/90"
                >
                  <CalendarPlus className="size-4" aria-hidden="true" />
                  Confirm renewal
                </Button>
              </div>
            </>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-caption text-foreground-subtle">{label}</dt>
      <dd className="text-description break-words text-foreground">{children}</dd>
    </div>
  );
}
