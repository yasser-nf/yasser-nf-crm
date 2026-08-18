"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircle } from "lucide-react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { ActionError } from "@/lib/errors";
import type { AccountView } from "../services/accounts.service";
import { FormField } from "@/shared/forms/form-field";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Textarea } from "@/shared/ui/textarea";
import { ACCOUNT_STATUS_OPTIONS } from "./status-badge";

/**
 * Account create and edit form.
 *
 * One component for both, because the fields are the same and two near-identical
 * forms would drift. The differences are declared rather than duplicated: create
 * requires a password, edit makes it optional and adds status.
 *
 * 02_ARCHITECTURE.md: every form uses React Hook Form with Zod. The schema here
 * is the client-side copy; the service revalidates on the server, because
 * frontend validation is never trusted.
 */

const baseFields = {
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Email is required")
    .email("Enter a valid email address"),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .length(2, "Use a 2-letter country code, such as DZ")
    .or(z.literal(""))
    .optional(),
  notes: z.string().trim().max(2000, "Notes are limited to 2000 characters").optional(),
};

/**
 * How the operator wants to express the account's coverage.
 *
 * A mode rather than three loose fields, because "open-ended" and "expires in
 * 90 days" are different intentions and a blank date cannot distinguish them —
 * an empty box could mean either "no boundary" or "I forgot". The mode makes
 * the choice explicit, and only the fields it needs are then rendered.
 */
const VALIDITY_MODES = ["open", "duration", "date"] as const;
type ValidityMode = (typeof VALIDITY_MODES)[number];

const createAccountFormSchema = z.object({
  ...baseFields,
  password: z.string().min(1, "Password is required").max(200),

  /*
   * Coerced: a <select> yields a string. Bounds mirror MIN/MAX_PROFILE_SLOTS in
   * the account schema — the server revalidates, and a test pins the two
   * together so this copy cannot quietly widen.
   */
  profileSlots: z.coerce.number().int().min(1).max(5),

  validityMode: z.enum(VALIDITY_MODES),
  validFrom: z.string().optional(),
  validUntil: z.string().optional(),
  durationDays: z.string().optional(),
});

const editAccountFormSchema = z.object({
  ...baseFields,
  /* Blank means "leave the stored password alone". */
  password: z.string().max(200).optional(),
  status: z.enum([
    "healthy",
    "payment_problem",
    "incorrect_password",
    "invalid_email",
    "something_went_wrong",
    "archived",
    "deleted",
  ]),
});

export type CreateAccountFormValues = z.infer<typeof createAccountFormSchema>;
export type EditAccountFormValues = z.infer<typeof editAccountFormSchema>;

interface AccountFormProps {
  readonly mode: "create" | "edit";
  /* A projection without the credential — this form never edits a password hash. */
  readonly account?: AccountView | undefined;
  readonly isSubmitting: boolean;
  readonly error?: unknown;
  readonly onSubmit: (values: Record<string, unknown>) => void;
  readonly onCancel: () => void;
}

export function AccountForm({
  mode,
  account,
  isSubmitting,
  error,
  onSubmit,
  onCancel,
}: AccountFormProps) {
  const isEdit = mode === "edit";

  const form = useForm({
    resolver: zodResolver(isEdit ? editAccountFormSchema : createAccountFormSchema),
    mode: "onTouched",
    defaultValues: {
      email: account?.email ?? "",
      password: "",
      country: account?.country ?? "",
      notes: account?.notes ?? "",
      ...(isEdit
        ? { status: account?.status ?? "healthy" }
        : {
            /* Five and open-ended: exactly how every pre-M13 account behaves. */
            profileSlots: 5,
            validityMode: "open" as ValidityMode,
            validFrom: "",
            validUntil: "",
            durationDays: "",
          }),
    },
  });

  const {
    register,
    handleSubmit,
    setValue,
    control,
    formState: { errors },
  } = form;

  /* Server-side field errors are merged in, so they land on the right input. */
  const serverFieldErrors = error instanceof ActionError ? (error.fieldErrors ?? {}) : {};

  const fieldError = (name: string): string | undefined => {
    const formError = errors[name as keyof typeof errors];
    return (formError?.message as string | undefined) ?? serverFieldErrors[name];
  };

  /**
   * Server errors naming a field this form does not render.
   *
   * Account creation was broken from the day it was written and nobody could
   * see why: the schema rejected `healthScore`, which no input collects, so the
   * error attached to nothing and the form looked like it had simply refused
   * without saying anything.
   *
   * An error with nowhere to go must still be shown. Silence is the one
   * response a form must never give.
   */
  const RENDERED_FIELDS = [
    "email",
    "password",
    "country",
    "notes",
    "status",
    "profileSlots",
    "validFrom",
    "validUntil",
    "durationDays",
  ];

  const unmappedErrors = Object.entries(serverFieldErrors).filter(
    ([field]) => !RENDERED_FIELDS.includes(field),
  );

  const submit = handleSubmit((values) => {
    const payload: Record<string, unknown> = {
      email: values.email,
      country: values.country === "" ? undefined : values.country,
      notes: values.notes === "" ? undefined : values.notes,
    };

    if (isEdit) {
      payload["status"] = (values as EditAccountFormValues).status;
      /* Only send a password when one was actually typed. */
      if (values.password) {
        payload["password"] = values.password;
      }
    } else {
      const created = values as CreateAccountFormValues;

      payload["password"] = values.password;
      payload["profileSlots"] = Number(created.profileSlots);

      /*
       * Only the fields the chosen mode actually means are sent. The service
       * turns a duration into `valid_until` through `resolveValidity` — the UI
       * deliberately performs NO date arithmetic, so there is exactly one
       * implementation of "90 days from now" and it lives on the server.
       *
       * Open-ended sends nothing at all, which is how the model already spells
       * "no boundary": both columns stay null.
       */
      if (created.validFrom) {
        payload["validFrom"] = created.validFrom;
      }

      if (created.validityMode === "duration") {
        const days = created.durationDays;
        /* Sent as typed when unparseable, so the server's message names the real input. */
        payload["durationDays"] = days === "" || days === undefined ? undefined : Number(days);
      }

      if (created.validityMode === "date") {
        payload["validUntil"] = created.validUntil || undefined;
      }
    }

    onSubmit(payload);
  });

  /*
   * useWatch rather than watch(). watch() returns a fresh function on every
   * render, which React Compiler cannot memoize — it responds by skipping
   * optimisation for the whole component. useWatch subscribes to one field and
   * stays compiler-friendly.
   */
  const status = useWatch({ control, name: "status" as never });

  /*
   * `useWatch` over a discriminated form union widens to that union, so both
   * are narrowed here once rather than cast at each use — the same treatment
   * `status` already gets two lines above.
   */
  const profileSlots = Number(useWatch({ control, name: "profileSlots" as never }) ?? 5);
  const validityMode = String(
    useWatch({ control, name: "validityMode" as never }) ?? "open",
  ) as ValidityMode;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {unmappedErrors.length > 0 ? (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-danger/30 bg-danger-subtle p-4"
        >
          <p className="text-card-title text-foreground">The server rejected this account</p>
          {unmappedErrors.map(([field, message]) => (
            <p key={field} className="text-caption text-foreground-muted">
              <span className="font-mono">{field}</span>: {message}
            </p>
          ))}
        </div>
      ) : null}

      <FormField
        label="Netflix email"
        type="email"
        inputMode="email"
        autoComplete="off"
        placeholder="account@example.com"
        disabled={isSubmitting}
        error={fieldError("email")}
        required
        {...register("email")}
      />

      <FormField
        label={isEdit ? "New password" : "Password"}
        type="password"
        autoComplete="new-password"
        placeholder={isEdit ? "Leave blank to keep the current password" : "Netflix password"}
        hint={isEdit ? "Only fill this in to replace the stored password." : undefined}
        disabled={isSubmitting}
        error={fieldError("password")}
        required={!isEdit}
        {...register("password")}
      />

      <FormField
        label="Country"
        placeholder="DZ"
        maxLength={2}
        disabled={isSubmitting}
        error={fieldError("country")}
        hint="Two-letter code. Optional."
        {...register("country")}
      />

      {!isEdit ? (
        <>
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="account-profile-slots"
              className="text-description font-medium text-foreground"
            >
              Sellable profiles
            </Label>
            <Select
              value={String(profileSlots ?? 5)}
              onValueChange={(value) => setValue("profileSlots" as never, Number(value) as never)}
              disabled={isSubmitting}
            >
              <SelectTrigger id="account-profile-slots" className="h-11 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4, 5].map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {count} profile{count === 1 ? "" : "s"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-caption text-foreground-subtle">
              The account always contains five profile rows. This sets how many of them may be sold
              — the rest are permanently marked Not for sale.
            </p>
            {fieldError("profileSlots") ? (
              <p role="alert" className="text-caption text-danger">
                {fieldError("profileSlots")}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label
              htmlFor="account-validity-mode"
              className="text-description font-medium text-foreground"
            >
              Account validity
            </Label>
            <Select
              value={String(validityMode ?? "open")}
              onValueChange={(value) => setValue("validityMode" as never, value as never)}
              disabled={isSubmitting}
            >
              <SelectTrigger id="account-validity-mode" className="h-11 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open-ended — no expiry</SelectItem>
                <SelectItem value="duration">Lasts a number of days</SelectItem>
                <SelectItem value="date">Expires on a date</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-caption text-foreground-subtle">
              How long this account can serve customers. Quick Prepare refuses a subscription longer
              than the account&apos;s remaining validity.
            </p>
          </div>

          {validityMode === "duration" ? (
            <FormField
              label="Duration (days)"
              type="number"
              inputMode="numeric"
              min={1}
              max={730}
              placeholder="90"
              disabled={isSubmitting}
              error={fieldError("durationDays")}
              hint="Counted from the start date below, or from today if none is given."
              {...register("durationDays")}
            />
          ) : null}

          {validityMode === "date" ? (
            <FormField
              label="Valid until"
              type="date"
              disabled={isSubmitting}
              error={fieldError("validUntil")}
              {...register("validUntil")}
            />
          ) : null}

          {validityMode !== "open" ? (
            <FormField
              label="Valid from"
              type="date"
              disabled={isSubmitting}
              error={fieldError("validFrom")}
              hint="Optional. Leave blank for an account that starts today."
              {...register("validFrom")}
            />
          ) : null}
        </>
      ) : null}

      {isEdit ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="account-status" className="text-description font-medium text-foreground">
            Status
          </Label>
          <Select
            value={String(status ?? "healthy")}
            onValueChange={(value) => setValue("status" as never, value as never)}
            disabled={isSubmitting}
          >
            <SelectTrigger id="account-status" className="h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCOUNT_STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-caption text-foreground-subtle">
            Anything other than Healthy blocks all five profiles from allocation.
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="account-notes" className="text-description font-medium text-foreground">
          Notes
        </Label>
        <Textarea
          id="account-notes"
          rows={3}
          placeholder="Anything worth remembering about this account"
          disabled={isSubmitting}
          className="bg-background-secondary"
          {...register("notes")}
        />
        {fieldError("notes") ? (
          <p role="alert" className="text-caption text-danger">
            {fieldError("notes")}
          </p>
        ) : null}
      </div>

      <div className="mt-2 flex items-center justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting} className="min-w-32">
          {isSubmitting ? (
            <>
              <LoaderCircle className="animate-spin" aria-hidden="true" />
              Saving
            </>
          ) : isEdit ? (
            "Save changes"
          ) : (
            "Create account"
          )}
        </Button>
      </div>
    </form>
  );
}
