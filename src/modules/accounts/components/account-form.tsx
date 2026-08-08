"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircle } from "lucide-react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { ActionError } from "@/lib/errors";
import type { AccountRow } from "@/lib/drizzle/schema";
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

const createAccountFormSchema = z.object({
  ...baseFields,
  password: z.string().min(1, "Password is required").max(200),
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
  readonly account?: AccountRow | undefined;
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
      ...(isEdit ? { status: account?.status ?? "healthy" } : {}),
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
      payload["password"] = values.password;
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

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
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
