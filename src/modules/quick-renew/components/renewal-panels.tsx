"use client";

import { TriangleAlert } from "lucide-react";

import { PROBLEM_TYPE_LABELS, ProblemStatusBadgeBase } from "@/shared/ui/problem-badges";
import {
  PROFILE_STATE_LABELS,
  PROFILE_STATE_STYLES,
  ProfileStateLegend,
  type ProfileSlotState,
} from "@/shared/ui/profile-state";
import { cn } from "@/utils/cn";
import type {
  RenewableProfile,
  RenewalPreview,
  RenewalQuoteResult,
} from "../services/renewal-lookup.service";

/**
 * The panels Quick Renew is made of. M09 §6, §7 and §16.
 *
 * Presentation only, and that is the contract: every state, date, day count and
 * refusal on these panels arrives from the server, derived by the same
 * functions the commit uses. Nothing here computes an expiry or decides whether
 * a profile may be renewed — M09 §22 and §24 require one interpretation of
 * those rules, and a second written in React would drift silently.
 *
 * `profiles.status` is deliberately never read. It says `sold` for allocations
 * that lapsed months ago, because nothing writes `expired` (ADR-013 D2). The
 * server's `profileCellState` is authoritative.
 *
 * Separated from the screen so the orchestration — which step is showing, what
 * has been chosen, what is in flight — reads as one piece rather than being
 * buried under markup.
 */

/** The server's own wording for a refusal, so the screen invents none. */
const BLOCKED_LABELS: Record<NonNullable<RenewableProfile["blockedReason"]>, string> = {
  account_unavailable: "account cannot sell",
  slot_not_for_sale: "not for sale",
  no_customer: "no customer",
  customer_blocked: "customer blocked",
  customer_archived: "customer archived",
};

/** One selectable slot. M09 §6. */
function ProfileRow({
  entry,
  selected,
  disabled,
  onSelect,
}: {
  readonly entry: RenewableProfile;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
  const state: ProfileSlotState = entry.state;
  const renewable = entry.blockedReason === null;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled || !renewable}
        aria-pressed={selected}
        className={cn(
          "flex w-full flex-col gap-2 rounded-md border p-3 text-left transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-60",
          selected
            ? "border-primary bg-primary-subtle"
            : "border-border bg-background-secondary hover:border-primary/40",
        )}
      >
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded border border-current/30 text-caption font-medium tabular-nums">
              {entry.profile.profileNumber}
            </span>
            <span className="text-description font-medium text-foreground">
              {entry.profile.profileName ?? `Profile ${entry.profile.profileNumber}`}
            </span>
          </span>

          <span
            className={cn(
              "rounded border px-2 py-0.5 text-caption font-medium",
              PROFILE_STATE_STYLES[state],
            )}
          >
            {PROFILE_STATE_LABELS[state]}
          </span>
        </span>

        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-foreground-muted">
          <span>
            {entry.customer.kind === "linked"
              ? (entry.customer.customer.name ?? entry.customer.customer.label)
              : entry.customer.kind === "none"
                ? "No customer assigned"
                : "Customer unavailable"}
          </span>

          {entry.profile.expirationDate ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                {entry.hasExpired ? "expired " : "expires "}
                {entry.profile.expirationDate}
              </span>
            </>
          ) : null}

          {!renewable && entry.blockedReason ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-warning">{BLOCKED_LABELS[entry.blockedReason]}</span>
            </>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/** The account and its slots. M09 §5 and §6. */
export function AccountPanel({
  preview,
  selectedId,
  disabled,
  onSelect,
}: {
  readonly preview: RenewalPreview;
  readonly selectedId: string | null;
  readonly disabled: boolean;
  readonly onSelect: (profileId: string) => void;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-card-title text-foreground">{preview.account.email}</h2>
        <p className="text-caption text-foreground-muted">
          {preview.profiles.length} profile{preview.profiles.length === 1 ? "" : "s"} ·{" "}
          {preview.account.profileSlots} sellable ·{" "}
          {preview.accountRemainingDays === null
            ? "open-ended validity"
            : `${preview.accountRemainingDays} days of account validity`}
        </p>
      </header>

      {/*
        One banner rather than the same refusal on five rows. The server decided
        it: `accountBlocksRenewal` is `accountCanAllocate` inverted, the rule
        01_MASTER_RULES.md states as "if an account is not Healthy, ALL its
        profiles become unavailable".
      */}
      {preview.accountBlocksRenewal ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-warning/40 bg-warning-subtle p-4"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <p className="text-caption text-foreground-muted">
            <span className="text-foreground">
              This account cannot serve anyone right now ({preview.effectiveStatus}).
            </span>{" "}
            Nothing on it can be renewed. Use Quick Replace to move the customer onto a working
            account instead.
          </p>
        </div>
      ) : null}

      <ul className="flex flex-col gap-2">
        {preview.profiles.map((entry) => (
          <ProfileRow
            key={entry.profile.id}
            entry={entry}
            selected={entry.profile.id === selectedId}
            disabled={disabled}
            onSelect={() => onSelect(entry.profile.id)}
          />
        ))}
      </ul>

      <ProfileStateLegend />
    </section>
  );
}

/** Open problems on the account, as the Problems module ordered them. */
export function ProblemsPanel({ problems }: { readonly problems: RenewalPreview["problems"] }) {
  if (problems.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-surface p-5">
      <header className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <h2 className="text-card-title text-foreground">
          {problems.length} open problem{problems.length === 1 ? "" : "s"} on this account
        </h2>
      </header>

      <ul className="flex flex-col gap-2">
        {problems.map((problem) => (
          <li key={problem.id} className="flex flex-wrap items-center gap-2">
            <span className="text-caption font-medium text-foreground">
              {PROBLEM_TYPE_LABELS[problem.issueType] ?? problem.issueType}
            </span>
            <ProblemStatusBadgeBase status={problem.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The customer and the subscription as they stand. M09 §6 and §7. */
export function SubscriptionPanel({ entry }: { readonly entry: RenewableProfile }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary-subtle p-5">
      <h2 className="text-card-title text-foreground">
        Profile {entry.profile.profileNumber}
        {entry.profile.profileName ? ` · ${entry.profile.profileName}` : ""}
      </h2>

      <dl className="flex flex-col gap-1.5 text-caption">
        {/*
          Whatever customer information the CRM actually holds, and nothing
          invented. Most customers are a phone number with no name — M09 §7 is
          explicit that an absent name must not be fabricated.
        */}
        <Detail
          label="Customer"
          value={
            entry.customer.kind === "linked"
              ? (entry.customer.customer.name ?? entry.customer.customer.label)
              : entry.customer.kind === "none"
                ? "No customer assigned"
                : "Customer unavailable"
          }
        />
        {entry.customer.kind === "linked" ? (
          <Detail label="Contact" value={entry.customer.customer.label} />
        ) : null}
        {entry.customerStatus ? (
          <Detail label="Customer status" value={entry.customerStatus} />
        ) : null}

        <Detail label="Sale date" value={entry.profile.saleDate ?? "not recorded"} />
        <Detail
          label="Current duration"
          value={
            entry.profile.durationDays === null
              ? "not recorded"
              : `${entry.profile.durationDays} days`
          }
        />
        <Detail label="Current expiry" value={entry.profile.expirationDate ?? "none recorded"} />
        <Detail
          label="Remaining"
          value={
            entry.remainingDays === null
              ? "open-ended"
              : entry.hasExpired
                ? `expired ${Math.abs(entry.remainingDays)} day${
                    Math.abs(entry.remainingDays) === 1 ? "" : "s"
                  } ago`
                : `${entry.remainingDays} day${entry.remainingDays === 1 ? "" : "s"}`
          }
          tone={entry.hasExpired ? "danger" : undefined}
        />
      </dl>

      {/*
        The PIN is deliberately absent, here and from the payload that feeds
        this screen: `ProfileView` drops it, which is how every browser-bound
        profile in the application is projected (M01.5). A renewal does not
        need it, and a value that never arrives cannot leak.
      */}
    </section>
  );
}

function Detail({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "danger";
}) {
  return (
    <div className="flex flex-wrap justify-between gap-3">
      <dt className="text-foreground-muted">{label}</dt>
      <dd className={cn("tabular-nums", tone === "danger" ? "text-danger" : "text-foreground")}>
        {value}
      </dd>
    </div>
  );
}

/** M09 §16: exactly what will happen, before it happens. */
export function ReviewPanel({ quote }: { readonly quote: RenewalQuoteResult }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-primary/40 bg-surface p-5">
      <header className="flex flex-col gap-1">
        <span className="w-fit rounded-md bg-primary-subtle px-2 py-0.5 text-caption font-medium text-primary">
          Preview — nothing has changed yet
        </span>
        <h2 className="text-card-title text-foreground">Review the renewal</h2>
      </header>

      <dl className="flex flex-col gap-2 text-caption">
        <Detail label="Account" value={quote.accountEmail} />
        <Detail
          label="Profile"
          value={`${quote.profileNumber}${quote.profileName ? ` · ${quote.profileName}` : ""}`}
        />
        <Detail
          label="Customer"
          value={
            quote.customer.kind === "linked"
              ? (quote.customer.customer.name ?? quote.customer.customer.label)
              : "Customer unavailable"
          }
        />
        <Detail
          label="Current expiry"
          value={quote.quote.previousExpirationDate ?? "none recorded"}
        />
        <Detail label="Renewal" value={`${quote.quote.label} (+${quote.quote.addedDays} days)`} />
        <Detail label="New expiry" value={quote.quote.expirationDate} />
      </dl>

      {/*
        The rule M09 §9 singles out, stated rather than implied — and the one an
        operator most needs to trust when they renew early.
      */}
      <div className="flex flex-col gap-1 rounded-md bg-background-secondary p-3">
        <p className="text-caption text-foreground">
          {quote.quote.basis === "current_expiry"
            ? `Counted from the current expiry (${quote.quote.baseDate}), not from today.`
            : `This subscription has lapsed, so the new term starts today (${quote.quote.baseDate}).`}
        </p>
        <p className="text-caption text-foreground-subtle">
          {quote.quote.basis === "current_expiry"
            ? "The customer keeps every day they have already paid for."
            : "An expired allocation has nothing left to carry over."}
        </p>
      </div>
    </section>
  );
}
