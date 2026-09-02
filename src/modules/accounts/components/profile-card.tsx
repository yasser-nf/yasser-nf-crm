"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { motion } from "framer-motion";
import { Ban, Pencil, TriangleAlert, User, Undo2 } from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { DURATION, EASING } from "@/config/theme";
import { ActionError } from "@/lib/errors";
import type { ProfileRow } from "@/lib/drizzle/schema";
import { deriveExpirationForInput } from "../services/profile-dates";
import type { ProfileAllocation } from "../services/accounts.service";
import { FormField } from "@/shared/forms/form-field";
import { Button } from "@/shared/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Textarea } from "@/shared/ui/textarea";
import { useUnassignSale, useUpdateProfile } from "../hooks/use-account-mutations";
import { ProfileStatusBadge } from "./status-badge";

/**
 * One of the five profile cards.
 *
 * 04_UI_GUIDELINES.md: profile cards are visually separated, each carrying a
 * status badge, PIN, customer, expiration and actions.
 *
 * The card shows an explicit blocked notice when the account's status makes the
 * profile unallocatable. Without it, a profile reading "Available" under a
 * Payment Problem account is actively misleading — the badge describes the
 * profile, and the rule lives on the account.
 */

/**
 * The editable set, mirroring `profileEditSchema` on the server.
 *
 * M13 §5 adds the allocation fields to M03's name and PIN. Everything here is
 * optional and blank means "leave it alone", so an operator editing a PIN never
 * has to retype a sale date.
 *
 * The server revalidates all of it and owns every business rule — this copy
 * exists only to catch a typo before a round trip.
 */
const profileEditFormSchema = z.object({
  profileName: z.string().trim().max(60).optional(),
  pin: z
    .string()
    .trim()
    .regex(/^[0-9]{4}$/, "PIN must be exactly 4 digits")
    .or(z.literal(""))
    .optional(),
  notes: z.string().trim().max(2000, "Notes are limited to 2000 characters").optional(),
  customerPhone: z.string().trim().optional(),
  saleDate: z.string().optional(),
  expirationDate: z.string().optional(),
  durationDays: z.string().optional(),
});

type ProfileEditFormValues = z.infer<typeof profileEditFormSchema>;

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
}

/** Statuses that mean a customer is holding this slot. Mirrors the repository. */
const HELD_STATUSES: readonly ProfileRow["status"][] = ["sold", "reserved", "expiring_soon"];

export function ProfileCard({
  allocation,
  accountId,
  customerLabel,
  canUnassignSale = false,
  index,
}: {
  allocation: ProfileAllocation;
  accountId: string;
  customerLabel: string | null;
  /**
   * Whether the signed-in user may remove a sale.
   *
   * Decided on the server and passed down, so the button is absent rather than
   * disabled for everyone else. The service checks the same permission — this
   * only stops the control being offered, it is not what enforces it.
   */
  canUnassignSale?: boolean;
  index: number;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [confirmingUnassign, setConfirmingUnassign] = useState(false);
  const { profile, isAllocatable, blockedReason } = allocation;
  const unassign = useUnassignSale(accountId, profile.id);

  /* Only a slot somebody is actually holding can have its sale removed. */
  const isHeld = HELD_STATUSES.includes(profile.status);

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: DURATION.base,
        ease: EASING.out,
        delay: Math.min(index * 0.04, 0.2),
      }}
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-raised text-card-title font-bold text-foreground-muted"
          >
            {profile.profileNumber}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-card-title text-foreground">
              {profile.profileName ?? `Profile ${profile.profileNumber}`}
            </span>
            <span className="text-caption text-foreground-subtle">
              PIN {profile.pin ?? "not set"}
            </span>
          </div>
        </div>

        {/*
          The badge must agree with the indicator strip above the cards.

          Reading `profile.status` alone renders a green "Available" on a slot
          the allocator will never sell — the column says available because
          sellability is derived, not stored. `blockedReason` is the derived
          answer, from the same `evaluateAllocation` the strip uses.
        */}
        <ProfileStatusBadge
          status={profile.status}
          notForSale={blockedReason === "profile_not_for_sale"}
          expiringSoon={allocation.state === "expiring_soon"}
        />
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-caption">
        <div className="flex flex-col gap-0.5">
          <dt className="text-foreground-subtle">Customer</dt>
          <dd className="flex items-center gap-1.5 text-foreground">
            {customerLabel ? (
              <>
                <User className="size-3 shrink-0 text-foreground-subtle" aria-hidden="true" />
                <span className="truncate">{customerLabel}</span>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>

        <div className="flex flex-col gap-0.5">
          <dt className="text-foreground-subtle">Sale date</dt>
          <dd className="text-foreground">{formatDate(profile.saleDate)}</dd>
        </div>

        <div className="flex flex-col gap-0.5">
          <dt className="text-foreground-subtle">Expires</dt>
          <dd className="text-foreground">{formatDate(profile.expirationDate)}</dd>
        </div>

        <div className="flex flex-col gap-0.5">
          <dt className="text-foreground-subtle">Duration</dt>
          <dd className="text-foreground">
            {profile.durationDays ? `${profile.durationDays} days` : "—"}
          </dd>
        </div>
      </dl>

      {!isAllocatable && blockedReason === "account_not_healthy" ? (
        <p className="flex items-start gap-2 rounded-md bg-warning-subtle p-3 text-caption text-warning">
          <Ban className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          Blocked by the account&apos;s status. Not available for allocation regardless of the badge
          above.
        </p>
      ) : null}

      <div className="mt-auto flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIsEditing(true)}
          className="h-9 w-full gap-2 sm:w-auto"
        >
          <Pencil className="size-3.5" aria-hidden="true" />
          Edit profile
        </Button>

        {/* Absent on an available slot: there is no sale to remove. */}
        {isHeld && canUnassignSale ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmingUnassign(true)}
            loading={unassign.isPending}
            loadingLabel="Removing"
            className="h-9 w-full gap-2 text-danger sm:w-auto"
          >
            <Undo2 className="size-3.5" aria-hidden="true" />
            Unassign sale
          </Button>
        ) : null}
      </div>

      <AlertDialog open={confirmingUnassign} onOpenChange={setConfirmingUnassign}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-danger" aria-hidden="true" />
              Are you sure you want to remove the sale from this profile?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Profile {profile.profileNumber} becomes available again straight away and can be sold
              to someone else. The customer loses access to it, and any days they had left are not
              carried anywhere — use Quick Replace instead if they should keep them.
              <br />
              <br />
              The customer record and the account are kept, and this is recorded in the account
              history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unassign.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => unassign.mutate()}
              disabled={unassign.isPending}
              className="bg-danger text-white hover:bg-danger/90"
            >
              {unassign.isPending ? "Removing…" : "Remove sale"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <EditProfileDialog
        profile={profile}
        accountId={accountId}
        /* Allocation fields are hidden on a slot that cannot hold one. */
        canAllocate={blockedReason !== "profile_not_for_sale"}
        open={isEditing}
        onOpenChange={setIsEditing}
      />
    </motion.article>
  );
}

/**
 * The profile editor.
 *
 * Three groups, because they carry different risk: identity is always safe to
 * change, the allocation block can only be edited on a sellable slot and is
 * validated against the account's own validity, and notes are free text.
 *
 * Every field is optional and blank means "leave it alone", so editing a PIN
 * does not require retyping a sale date.
 *
 * The customer is entered as a PHONE NUMBER, not an id — the server resolves it
 * through the same `findOrCreateByPhone` Quick Prepare uses, so the Phone Engine
 * matches an existing customer rather than creating a duplicate.
 *
 * No account credential is passed to this component and none is rendered. The
 * PIN is shown because the operator is editing it; the account password has no
 * business here and is not reachable from it.
 */
function EditProfileDialog({
  profile,
  accountId,
  canAllocate,
  open,
  onOpenChange,
}: {
  profile: ProfileRow;
  accountId: string;
  canAllocate: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateProfile(accountId, profile.id);

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<ProfileEditFormValues>({
    resolver: zodResolver(profileEditFormSchema),
    mode: "onTouched",
    defaultValues: {
      profileName: profile.profileName ?? "",
      pin: profile.pin ?? "",
      notes: profile.notes ?? "",
      customerPhone: "",
      saleDate: profile.saleDate ?? "",
      /*
       * Derived on load, not read from the row.
       *
       * A profile saved before expiration became derived can carry a stored
       * value that disagrees with its own sale date and duration. Showing that
       * number would present the disagreement as fact; recomputing it shows
       * what the record actually means, and the next save writes it back.
       */
      expirationDate: deriveExpirationForInput(
        profile.saleDate ?? "",
        profile.durationDays ? String(profile.durationDays) : "",
      ),
      durationDays: profile.durationDays ? String(profile.durationDays) : "",
    },
  });

  /*
   * useWatch, not watch(): watch() returns a new function each render and stops
   * React Compiler. These two are the only inputs expiration has.
   */
  const watchedSaleDate = useWatch({ control, name: "saleDate" });
  const watchedDuration = useWatch({ control, name: "durationDays" });

  const derivedExpiration = deriveExpirationForInput(watchedSaleDate, watchedDuration);

  const serverFieldErrors =
    update.error instanceof ActionError ? (update.error.fieldErrors ?? {}) : {};

  const fieldError = (name: keyof ProfileEditFormValues): string | undefined =>
    errors[name]?.message ?? serverFieldErrors[name];

  /*
   * A server error naming a field this dialog does not render would otherwise
   * vanish, which is the exact failure that hid the account-creation bug for
   * ten milestones.
   */
  const RENDERED = [
    "profileName",
    "pin",
    "notes",
    "customerPhone",
    "saleDate",
    "expirationDate",
    "durationDays",
  ];

  const unmapped = Object.entries(serverFieldErrors).filter(([field]) => !RENDERED.includes(field));

  const submit = handleSubmit((values) => {
    const payload: Record<string, unknown> = {};

    /* Only what the operator actually filled in. Blank means "unchanged". */
    if (values.profileName) payload["profileName"] = values.profileName;
    if (values.pin) payload["pin"] = values.pin;
    if (values.notes) payload["notes"] = values.notes;

    if (canAllocate) {
      if (values.customerPhone) payload["customerPhone"] = values.customerPhone;
      if (values.saleDate) payload["saleDate"] = values.saleDate;
      if (values.durationDays) payload["durationDays"] = Number(values.durationDays);
      /*
       * expirationDate is deliberately absent. The service derives it from the
       * two fields above, so sending a copy would only create something for it
       * to disagree with — and a client is not the authority on it anyway.
       */
    }

    update.mutate(payload, { onSuccess: () => onOpenChange(false) });
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!update.isPending) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit profile {profile.profileNumber}</DialogTitle>
          <DialogDescription>
            The profile number is fixed for life. Allocation changes follow the same rules as Quick
            Prepare and cannot outlive the account.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          {unmapped.length > 0 ? (
            <div
              role="alert"
              className="flex flex-col gap-1 rounded-md border border-danger/30 bg-danger-subtle p-4"
            >
              <p className="text-card-title text-foreground">The server rejected this change</p>
              {unmapped.map(([field, message]) => (
                <p key={field} className="text-caption text-foreground-muted">
                  <span className="font-mono">{field}</span>: {message}
                </p>
              ))}
            </div>
          ) : null}

          <fieldset className="flex flex-col gap-4">
            <legend className="text-caption font-medium text-foreground-subtle">Identity</legend>

            <FormField
              label="Profile name"
              placeholder={`Profile ${profile.profileNumber}`}
              disabled={update.isPending}
              error={fieldError("profileName")}
              {...register("profileName")}
            />

            <FormField
              label="PIN"
              inputMode="numeric"
              maxLength={4}
              placeholder="4 digits"
              disabled={update.isPending}
              error={fieldError("pin")}
              {...register("pin")}
            />
          </fieldset>

          {canAllocate ? (
            <fieldset className="flex flex-col gap-4">
              <legend className="text-caption font-medium text-foreground-subtle">
                Customer &amp; allocation
              </legend>

              <FormField
                label="Customer phone"
                inputMode="tel"
                placeholder="0663 94 71 16"
                hint="Any Algerian format. An existing customer is matched, never duplicated. Leave blank to keep the current one."
                disabled={update.isPending}
                error={fieldError("customerPhone")}
                {...register("customerPhone")}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  label="Sale date"
                  type="date"
                  disabled={update.isPending}
                  error={fieldError("saleDate")}
                  {...register("saleDate")}
                />

                {/*
                  Read-only because it is derived. Not disabled: a disabled
                  input is dimmed and skipped by the keyboard, and this value is
                  the one the operator most wants to read back after changing a
                  duration.

                  Deliberately not registered either. Registering it would put a
                  second, editable copy in form state that could be submitted
                  and disagree with the two fields above it, which is the bug
                  this change exists to remove.
                */}
                <FormField
                  label="Expiration date"
                  type="date"
                  readOnly
                  tabIndex={-1}
                  value={derivedExpiration}
                  hint="Calculated from sale date + duration."
                  className="cursor-not-allowed text-foreground-muted"
                  error={fieldError("expirationDate")}
                />
              </div>

              <FormField
                label="Duration (days)"
                type="number"
                inputMode="numeric"
                min={1}
                max={730}
                disabled={update.isPending}
                error={fieldError("durationDays")}
                {...register("durationDays")}
              />
            </fieldset>
          ) : (
            <p className="flex items-start gap-2 rounded-md bg-neutral-subtle p-3 text-caption text-foreground-subtle">
              <Ban className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              This profile is above the account&apos;s sellable count, so it cannot hold an
              allocation. Its name, PIN and notes can still be edited.
            </p>
          )}

          <fieldset className="flex flex-col gap-2">
            <legend className="text-caption font-medium text-foreground-subtle">Notes</legend>

            <Textarea
              rows={3}
              placeholder="Anything worth remembering about this profile"
              disabled={update.isPending}
              className="bg-background-secondary"
              {...register("notes")}
            />
            {fieldError("notes") ? (
              <p role="alert" className="text-caption text-danger">
                {fieldError("notes")}
              </p>
            ) : null}
          </fieldset>

          <div className="flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={update.isPending}
              loadingLabel="Saving"
              className="min-w-28"
            >
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
