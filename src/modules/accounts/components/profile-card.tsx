"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { motion } from "framer-motion";
import { Ban, LoaderCircle, Pencil, User } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { DURATION, EASING } from "@/config/theme";
import { ActionError } from "@/lib/errors";
import type { ProfileAllocation } from "../services/accounts.service";
import { FormField } from "@/shared/forms/form-field";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { useUpdateProfile } from "../hooks/use-account-mutations";
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

/** Only name and PIN are editable. M03 forbids everything else. */
const profileEditFormSchema = z.object({
  profileName: z.string().trim().max(60).optional(),
  pin: z
    .string()
    .trim()
    .regex(/^[0-9]{4}$/, "PIN must be exactly 4 digits")
    .or(z.literal(""))
    .optional(),
});

type ProfileEditFormValues = z.infer<typeof profileEditFormSchema>;

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
}

export function ProfileCard({
  allocation,
  accountId,
  customerLabel,
  index,
}: {
  allocation: ProfileAllocation;
  accountId: string;
  customerLabel: string | null;
  index: number;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const { profile, isAllocatable, blockedReason } = allocation;

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

        <ProfileStatusBadge status={profile.status} />
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

      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsEditing(true)}
        className="mt-auto gap-2 self-start"
      >
        <Pencil className="size-3.5" aria-hidden="true" />
        Edit name &amp; PIN
      </Button>

      <EditProfileDialog
        accountId={accountId}
        profileId={profile.id}
        profileNumber={profile.profileNumber}
        currentName={profile.profileName}
        currentPin={profile.pin}
        open={isEditing}
        onOpenChange={setIsEditing}
      />
    </motion.article>
  );
}

function EditProfileDialog({
  accountId,
  profileId,
  profileNumber,
  currentName,
  currentPin,
  open,
  onOpenChange,
}: {
  accountId: string;
  profileId: string;
  profileNumber: number;
  currentName: string | null;
  currentPin: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateProfile(accountId, profileId);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ProfileEditFormValues>({
    resolver: zodResolver(profileEditFormSchema),
    mode: "onTouched",
    defaultValues: { profileName: currentName ?? "", pin: currentPin ?? "" },
  });

  const serverFieldErrors =
    update.error instanceof ActionError ? (update.error.fieldErrors ?? {}) : {};

  const submit = handleSubmit((values) => {
    const payload: Record<string, unknown> = {};

    if (values.profileName) {
      payload["profileName"] = values.profileName;
    }

    if (values.pin) {
      payload["pin"] = values.pin;
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit profile {profileNumber}</DialogTitle>
          <DialogDescription>
            Only the name and PIN can change. The profile number is fixed for life.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <FormField
            label="Profile name"
            placeholder={`Profile ${profileNumber}`}
            disabled={update.isPending}
            error={errors.profileName?.message ?? serverFieldErrors["profileName"]}
            {...register("profileName")}
          />

          <FormField
            label="PIN"
            inputMode="numeric"
            maxLength={4}
            placeholder="4 digits"
            disabled={update.isPending}
            error={errors.pin?.message ?? serverFieldErrors["pin"]}
            {...register("pin")}
          />

          <div className="mt-2 flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending} className="min-w-28">
              {update.isPending ? (
                <>
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                  Saving
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
