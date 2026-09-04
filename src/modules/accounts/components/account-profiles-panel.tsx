"use client";

import { Pencil } from "lucide-react";
import { useState } from "react";

import { PROFILE_STATE_LABELS, PROFILE_STATE_STYLES } from "@/shared/ui/profile-state";
import { Button } from "@/shared/ui/button";
import { cn } from "@/utils/cn";
import type { ProfileAllocationWithCustomer } from "../services/accounts.service";
import { ProfileCustomerLine } from "./profile-customer-line";
import { EditProfileDialog } from "./profile-card";

/**
 * The five profiles of one account, inline under its row.
 *
 * Every slot's colour and wording comes from `PROFILE_STATE_*`, keyed by the
 * `state` the service already derived through `profileCellState`. Nothing here
 * decides what a profile is — a second opinion in this panel would be a slot
 * reading green inline and yellow one click away.
 *
 * "Edit profile" opens `EditProfileDialog`, the same component the account
 * detail page opens. It is not a copy: it was module-private until this panel
 * needed it, and the detail page still mounts it unchanged.
 *
 * The panel renders no profile data of its own — no query, no fetch. The rows
 * arrive on `AccountListRow.profiles`, built from profile rows the accounts
 * query already loaded in one batch for the whole page.
 */

function formatDate(value: string | null): string {
  return value
    ? new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: "medium" })
    : "—";
}

export function AccountProfilesPanel({
  accountId,
  accountEmail,
  profiles,
  id,
}: {
  readonly accountId: string;
  readonly accountEmail: string;
  readonly profiles: readonly ProfileAllocationWithCustomer[];
  /** Matches the trigger's aria-controls, so the button announces what it owns. */
  readonly id: string;
}) {
  /*
   * One id, not a boolean per card. Holding "which profile is being edited"
   * rather than "is the dialog open" is what makes clicking Profile 3 open
   * Profile 3 — a shared open flag would reopen whichever profile was selected
   * last.
   */
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);

  const editing = profiles.find((entry) => entry.profile.id === editingProfileId) ?? null;

  return (
    <div id={id} className="rounded-lg border border-border bg-background-secondary p-4">
      <p className="mb-3 text-caption text-foreground-subtle">
        Profiles of <span className="text-foreground-muted">{accountEmail}</span>
      </p>

      {/*
        One column on a phone, two on a tablet, five where there is room. The
        table above is hidden below lg, so in practice this grid is what a small
        screen sees, and it never needs to scroll sideways.
      */}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {profiles.map((allocation) => {
          const { profile, state, customer } = allocation;
          /*
           * Driven by the RESOLVED link, not by `profile.status`. A lapsed slot
           * still reads "expired" in the status column while its customer is
           * very much still named on it, and the sale dates below belong to
           * that customer.
           */
          const isHeld = customer.kind !== "none";

          return (
            <li
              key={profile.id}
              className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    "inline-flex size-6 shrink-0 items-center justify-center rounded-md border text-caption font-medium",
                    PROFILE_STATE_STYLES[state],
                  )}
                >
                  {profile.profileNumber}
                </span>

                <span
                  className={cn(
                    "truncate text-caption",
                    PROFILE_STATE_STYLES[state].split(" ").at(-1),
                  )}
                >
                  {PROFILE_STATE_LABELS[state]}
                </span>
              </div>

              <div className="min-w-0">
                <p className="truncate text-description text-foreground">
                  {profile.profileName ?? `Profile ${profile.profileNumber}`}
                </p>
                <p className="text-caption text-foreground-subtle">
                  PIN {profile.pin ?? "not set"}
                </p>
              </div>

              <dl className="flex flex-col gap-1 text-caption">
                <ProfileCustomerLine customer={customer} />
                {/*
                  Sale, expiry and duration are only meaningful for a slot that
                  is actually held. Showing three dashes on free stock is noise.
                */}
                {isHeld ? (
                  <>
                    <Row label="Sold" value={formatDate(profile.saleDate)} />
                    <Row label="Expires" value={formatDate(profile.expirationDate)} />
                    <Row
                      label="Duration"
                      value={profile.durationDays ? `${profile.durationDays} days` : "—"}
                    />
                  </>
                ) : null}
                {profile.notes ? <Row label="Notes" value={profile.notes} /> : null}
              </dl>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditingProfileId(profile.id)}
                aria-label={`Edit profile ${profile.profileNumber} of ${accountEmail}`}
                className="mt-auto w-full gap-2"
              >
                <Pencil className="size-3.5" aria-hidden="true" />
                Edit profile
              </Button>
            </li>
          );
        })}
      </ul>

      {/*
        Rendered once, for whichever profile is selected, and keyed by profile id
        so switching between two profiles remounts the form rather than leaving
        the previous profile's values in the fields.
      */}
      {editing ? (
        <EditProfileDialog
          key={editing.profile.id}
          profile={editing.profile}
          /* The selected profile's own customer, not the one before it. */
          customer={editing.customer}
          accountId={accountId}
          /* Allocation fields are hidden on a slot that cannot hold one. */
          canAllocate={editing.blockedReason !== "profile_not_for_sale"}
          open
          onOpenChange={(next) => {
            if (!next) {
              setEditingProfileId(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-foreground-subtle">{label}</dt>
      <dd className="min-w-0 truncate text-right text-foreground-muted">{value}</dd>
    </div>
  );
}
