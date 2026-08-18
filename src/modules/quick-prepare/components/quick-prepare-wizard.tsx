"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { motion } from "framer-motion";
import { ArrowLeft, Check, LoaderCircle, TriangleAlert, Zap } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { DURATION, EASING } from "@/config/theme";
import { ActionError } from "@/lib/errors";
import { formatPhoneForDisplay, isValidAlgerianPhone, normalizePhone } from "@/lib/phone";
import { FormField } from "@/shared/forms/form-field";
import { CredentialResult } from "./credential-result";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { useConfirmPreparation, usePreviewAllocation } from "../hooks/use-quick-prepare";
import type { PreparationPreview, PreparationResult } from "../services/quick-prepare.service";

/**
 * Quick Prepare wizard.
 *
 * 04_UI_GUIDELINES.md calls this the flagship feature and asks for a wizard:
 *
 *   Profiles → Duration → Customer → Preview → Confirm
 *
 * Collapsed into one form plus a review step. The four inputs fit on a single
 * screen, and a worker preparing dozens of orders a day should not click Next
 * three times to type four fields. The review step is kept, because it carries
 * the warning the brief requires before anything is allocated.
 */

const formSchema = z.object({
  profileCount: z.coerce.number().int().min(1, "At least one profile").max(20, "Maximum 20"),
  durationDays: z.coerce.number().int().min(1, "At least one day").max(730, "Maximum two years"),
  phone: z
    .string()
    .trim()
    .min(1, "Customer phone is required")
    .refine(isValidAlgerianPhone, "Try 0663947116 or +213663947116"),
  notes: z.string().trim().max(2000).optional(),
});

type FormValues = z.input<typeof formSchema>;

/** Common subscription lengths, so the usual case is one tap. */
const DURATION_PRESETS = [30, 60, 90, 180, 365] as const;

type Stage = "form" | "review" | "done";

export function QuickPrepareWizard({ availableStock }: { availableStock: number }) {
  const [stage, setStage] = useState<Stage>("form");
  const [result, setResult] = useState<PreparationResult | null>(null);
  /* M13 §8. Reset whenever a new preview arrives, so it is never carried over. */
  const [passwordChanged, setPasswordChanged] = useState(false);

  const preview = usePreviewAllocation();
  const confirm = useConfirmPreparation();

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onTouched",
    defaultValues: { profileCount: 1, durationDays: 30, phone: "", notes: "" },
  });

  const serverFieldErrors =
    confirm.error instanceof ActionError ? (confirm.error.fieldErrors ?? {}) : {};
  const previewFieldErrors =
    preview.error instanceof ActionError ? (preview.error.fieldErrors ?? {}) : {};

  function fieldError(name: keyof FormValues): string | undefined {
    return (
      (errors[name]?.message as string | undefined) ??
      serverFieldErrors[name] ??
      previewFieldErrors[name]
    );
  }

  const goToReview = handleSubmit((values) => {
    /*
     * The duration travels with the count. Without it the preview would not
     * apply account validity, and a worker could be shown an account that the
     * confirm step then refuses — after they had already named it to the
     * customer.
     */
    preview.mutate(
      {
        profileCount: Number(values.profileCount),
        durationDays: Number(values.durationDays),
      },
      {
        onSuccess: () => {
          /* A fresh preview means a fresh decision about the password. */
          setPasswordChanged(false);
          setStage("review");
        },
      },
    );
  });

  function submitConfirmation() {
    const values = getValues();

    confirm.mutate(
      {
        profileCount: Number(values.profileCount),
        durationDays: Number(values.durationDays),
        phone: values.phone,
        notes: values.notes || undefined,
        /*
         * Permission to proceed, not evidence. The server re-derives whether a
         * password change is required from the accounts it actually locks, and
         * refuses if this is missing — see `confirm` in quick-prepare.service.
         */
        passwordChangeConfirmed: passwordChanged,
      },
      {
        onSuccess: (data) => {
          setResult(data);
          setStage("done");
        },
        /*
         * Stock moved under us, or the server refused the confirmation. Stay on
         * the review step so the error is visible next to what caused it —
         * bouncing back to the form would hide it.
         */
        onError: () => setStage("review"),
      },
    );
  }

  function startOver() {
    reset();
    setResult(null);
    preview.reset();
    confirm.reset();
    setStage("form");
  }

  if (stage === "done" && result) {
    return (
      <CredentialResult
        result={result}
        title={`Prepared${result.customerIsNew ? " for a new customer" : ""}`}
        restartLabel="Prepare another"
        onStartOver={startOver}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <StockBanner available={availableStock} />

      {stage === "form" ? (
        <motion.form
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DURATION.base, ease: EASING.out }}
          onSubmit={goToReview}
          noValidate
          className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-6"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Profiles needed"
              type="number"
              inputMode="numeric"
              min={1}
              max={20}
              disabled={preview.isPending}
              error={fieldError("profileCount")}
              required
              {...register("profileCount")}
            />

            <FormField
              label="Duration (days)"
              type="number"
              inputMode="numeric"
              min={1}
              disabled={preview.isPending}
              error={fieldError("durationDays")}
              required
              {...register("durationDays")}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {DURATION_PRESETS.map((days) => (
              <Button
                key={days}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setValue("durationDays", days, { shouldValidate: true })}
              >
                {days} days
              </Button>
            ))}
          </div>

          <FormField
            label="Customer phone"
            inputMode="tel"
            placeholder="0663 94 71 16"
            hint="Any Algerian format. It is normalised automatically."
            disabled={preview.isPending}
            error={fieldError("phone")}
            required
            {...register("phone")}
          />

          <div className="flex flex-col gap-2">
            <Label htmlFor="qp-notes" className="text-description font-medium text-foreground">
              Notes
            </Label>
            <Textarea
              id="qp-notes"
              rows={2}
              placeholder="Optional"
              disabled={preview.isPending}
              className="bg-background-secondary"
              {...register("notes")}
            />
          </div>

          <Button type="submit" size="lg" disabled={preview.isPending} className="h-11 gap-2">
            {preview.isPending ? (
              <>
                <LoaderCircle className="animate-spin" aria-hidden="true" />
                Finding stock
              </>
            ) : (
              <>
                <Zap className="size-4" aria-hidden="true" />
                Find best accounts
              </>
            )}
          </Button>
        </motion.form>
      ) : null}

      {stage === "review" && preview.data ? (
        <ReviewStep
          preview={preview.data}
          phone={getValues("phone")}
          isConfirming={confirm.isPending}
          passwordChanged={passwordChanged}
          onPasswordChangedChange={setPasswordChanged}
          confirmError={confirm.error}
          onBack={() => setStage("form")}
          onConfirm={submitConfirmation}
        />
      ) : null}
    </div>
  );
}

function StockBanner({ available }: { available: number }) {
  const isEmpty = available === 0;

  return (
    <div
      className={`flex items-center gap-3 rounded-md border p-4 ${
        isEmpty ? "border-danger/30 bg-danger-subtle" : "border-border bg-surface"
      }`}
    >
      <Zap
        className={`size-4 shrink-0 ${isEmpty ? "text-danger" : "text-primary"}`}
        aria-hidden="true"
      />
      <p className="text-description text-foreground">
        {isEmpty ? (
          "No profiles are available on healthy accounts right now."
        ) : (
          <>
            <span className="font-medium">{available}</span> profile
            {available === 1 ? "" : "s"} available for allocation
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Step 2: what the server would allocate, before it allocates anything.
 *
 * Everything here comes from the preview the SERVER produced. The component
 * computes no eligibility, no expiry and no reuse — M13 §5 is explicit that the
 * backend decides whether a password change is required, and this renders that
 * decision rather than reaching one.
 */
function ReviewStep({
  preview,
  phone,
  isConfirming,
  passwordChanged,
  onPasswordChangedChange,
  confirmError,
  onBack,
  onConfirm,
}: {
  preview: PreparationPreview;
  phone: string;
  isConfirming: boolean;
  passwordChanged: boolean;
  onPasswordChangedChange: (next: boolean) => void;
  confirmError: unknown;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const normalized = normalizePhone(phone);

  const serverError = confirmError instanceof ActionError ? confirmError : null;
  const confirmationError = serverError?.fieldErrors?.["passwordChangeConfirmed"];

  /* The server refuses without this; the button mirrors that rather than owning it. */
  const blocked = preview.requiresPasswordChange && !passwordChanged;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASING.out }}
      className="flex flex-col gap-5"
    >
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-section-title text-foreground">
          {preview.requested} profile{preview.requested === 1 ? "" : "s"} across{" "}
          {preview.accounts.length} account{preview.accounts.length === 1 ? "" : "s"}
        </h2>

        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-caption">
          <div className="flex flex-col">
            <dt className="text-foreground-subtle">Customer</dt>
            <dd className="text-foreground">
              {normalized.ok ? formatPhoneForDisplay(normalized.value.normalized) : phone}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-foreground-subtle">Duration</dt>
            <dd className="text-foreground">{preview.durationDays} days</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-foreground-subtle">Expires</dt>
            <dd className="text-foreground">{preview.expirationDate}</dd>
          </div>
        </dl>

        <ul className="flex flex-col gap-2">
          {preview.accounts.map((account) => (
            <li
              key={account.accountId}
              className="flex flex-col gap-1 rounded-md bg-background-secondary px-4 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate text-description text-foreground">
                  {account.email}
                </span>
                <span className="text-caption text-foreground-muted">
                  Profile{account.profileNumbers.length === 1 ? "" : "s"}{" "}
                  {account.profileNumbers.join(", ")} · health {account.healthScore}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-x-3 text-caption">
                <span className="text-foreground-subtle">
                  Account validity:{" "}
                  {account.remainingValidityDays === null
                    ? "Open-ended"
                    : `${account.remainingValidityDays} days left`}
                </span>
                {account.requiresPasswordChange ? (
                  <span className="text-warning">· password change required</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/*
        M13 §7. Shown only when the SERVER flagged reuse, so it keeps its force:
        a warning on every preparation is a warning nobody reads.
      */}
      {preview.requiresPasswordChange ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning-subtle p-4"
        >
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <div className="flex flex-col gap-1">
              <p className="text-card-title text-foreground">Important</p>
              <p className="text-caption text-foreground-muted">
                This account previously belonged to another customer whose subscription has expired.
                You must change the account password and update the profile before giving it to the
                new customer.
              </p>
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-md bg-background-secondary p-3">
            <input
              type="checkbox"
              checked={passwordChanged}
              disabled={isConfirming}
              onChange={(event) => onPasswordChangedChange(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span className="text-caption text-foreground">
              I have changed the Netflix password on this account.
            </span>
          </label>

          {confirmationError ? (
            <p role="alert" className="text-caption text-danger">
              {confirmationError}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* The checks the brief requires before anything is allocated. */}
      <div className="flex items-start gap-3 rounded-md border border-border bg-surface p-4">
        <TriangleAlert
          className="mt-0.5 size-4 shrink-0 text-foreground-subtle"
          aria-hidden="true"
        />
        <div className="flex flex-col gap-2">
          <p className="text-card-title text-foreground">Before you confirm</p>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-caption text-foreground-muted">
            <li>Change the profile name</li>
            <li>Change the PIN if necessary</li>
            <li>Verify the account works</li>
          </ul>
        </div>
      </div>

      {serverError && !confirmationError ? (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-subtle p-4 text-caption text-danger"
        >
          {serverError.userMessage}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onBack} disabled={isConfirming} className="gap-2">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back
        </Button>
        <Button
          size="lg"
          onClick={onConfirm}
          disabled={isConfirming || blocked}
          className="h-11 min-w-44 gap-2"
        >
          {isConfirming ? (
            <>
              <LoaderCircle className="animate-spin" aria-hidden="true" />
              Allocating
            </>
          ) : (
            <>
              <Check className="size-4" aria-hidden="true" />
              Confirm allocation
            </>
          )}
        </Button>
      </div>
    </motion.div>
  );
}
