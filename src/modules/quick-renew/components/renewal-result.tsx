"use client";

import { CalendarCheck, RotateCcw } from "lucide-react";

import { Button } from "@/shared/ui/button";
import type { RenewalResult } from "../services/quick-renew.service";

/**
 * What happened. M09 §17.
 *
 * Rendered INSTEAD of the review screen rather than beneath it, so a refusal
 * can never sit next to a success — the same choice `CredentialResult` makes in
 * Quick Prepare.
 *
 * Every number here is the server's. Nothing is recomputed, because the point
 * of this screen is to show what was written.
 */
export function RenewalResultPanel({
  result,
  onStartOver,
}: {
  readonly result: RenewalResult;
  readonly onStartOver: () => void;
}) {
  const customerLabel =
    result.customer.kind === "linked"
      ? (result.customer.customer.name ?? result.customer.customer.label)
      : "Customer unavailable";

  const customerContact = result.customer.kind === "linked" ? result.customer.customer.label : null;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4 rounded-lg border border-success/40 bg-success-subtle p-5">
        <header className="flex items-start gap-3">
          <CalendarCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <h2 className="text-card-title text-foreground">Renewal successful</h2>
            <p className="text-caption text-foreground-muted">
              {result.basis === "current_expiry"
                ? "Extended from the previous expiry — no paid days were lost."
                : "The subscription had lapsed, so the new term starts today."}
            </p>
          </div>
        </header>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
        <dl className="flex flex-col gap-3 text-caption">
          <Row label="Account" value={result.accountEmail} />
          <Row
            label="Profile"
            value={`${result.profileNumber}${result.profileName ? ` · ${result.profileName}` : ""}`}
          />
          <Row label="Customer" value={customerLabel} secondary={customerContact} />

          <div className="h-px bg-border" role="presentation" />

          <Row label="Previous expiry" value={result.previousExpirationDate ?? "none recorded"} />
          <Row label="Renewal" value={`${result.renewalLabel} (+${result.addedDays} days)`} />
          <Row label="New expiry" value={result.expirationDate} emphasis />
        </dl>
      </section>

      <div className="flex justify-end">
        <Button variant="secondary" onClick={onStartOver} className="gap-2">
          <RotateCcw className="size-4" aria-hidden="true" />
          Renew another
        </Button>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  secondary,
  emphasis,
}: {
  readonly label: string;
  readonly value: string;
  readonly secondary?: string | null;
  readonly emphasis?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <dt className="text-foreground-muted">{label}</dt>
      <dd
        className={
          emphasis
            ? "text-description font-medium text-success tabular-nums"
            : "text-foreground tabular-nums"
        }
      >
        {value}
        {secondary ? <span className="ml-2 text-foreground-subtle">{secondary}</span> : null}
      </dd>
    </div>
  );
}
