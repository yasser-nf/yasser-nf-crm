"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Check,
  Copy,
  LoaderCircle,
  MessageCircle,
  RotateCcw,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { DURATION, EASING } from "@/config/theme";
import { copyToClipboard } from "@/lib/clipboard";
import { ActionError } from "@/lib/errors";
import { formatPhoneForDisplay, isValidAlgerianPhone, normalizePhone } from "@/lib/phone";
import { FormField } from "@/shared/forms/form-field";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { useConfirmPreparation, usePreviewAllocation } from "../hooks/use-quick-prepare";
import type { PreparationResult } from "../services/quick-prepare.service";

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
    preview.mutate(Number(values.profileCount), {
      onSuccess: () => setStage("review"),
    });
  });

  function submitConfirmation() {
    const values = getValues();

    confirm.mutate(
      {
        profileCount: Number(values.profileCount),
        durationDays: Number(values.durationDays),
        phone: values.phone,
        notes: values.notes || undefined,
      },
      {
        onSuccess: (data) => {
          setResult(data);
          setStage("done");
        },
        /* Stock moved under us. Send them back to re-preview rather than guess. */
        onError: () => setStage("form"),
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
    return <PreparationOutput result={result} onStartOver={startOver} />;
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
          durationDays={Number(getValues("durationDays"))}
          isConfirming={confirm.isPending}
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

function ReviewStep({
  preview,
  phone,
  durationDays,
  isConfirming,
  onBack,
  onConfirm,
}: {
  preview: {
    accounts: readonly {
      accountId: string;
      email: string;
      healthScore: number;
      profileNumbers: readonly number[];
    }[];
    requested: number;
  };
  phone: string;
  durationDays: number;
  isConfirming: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const normalized = normalizePhone(phone);

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
            <dd className="text-foreground">{durationDays} days</dd>
          </div>
        </dl>

        <ul className="flex flex-col gap-2">
          {preview.accounts.map((account) => (
            <li
              key={account.accountId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-secondary px-4 py-3"
            >
              <span className="min-w-0 truncate text-description text-foreground">
                {account.email}
              </span>
              <span className="text-caption text-foreground-muted">
                Profiles {account.profileNumbers.join(", ")} · health {account.healthScore}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* The warning the brief requires before anything is allocated. */}
      <div
        role="alert"
        className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning-subtle p-4"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="flex flex-col gap-2">
          <p className="text-card-title text-foreground">Before you confirm</p>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-caption text-foreground-muted">
            <li>Change the profile name</li>
            <li>Change the PIN if necessary</li>
            <li>Verify the account works</li>
          </ul>
        </div>
      </div>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onBack} disabled={isConfirming} className="gap-2">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back
        </Button>
        <Button
          size="lg"
          onClick={onConfirm}
          disabled={isConfirming}
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

/**
 * The delivery block.
 *
 * One-click copy is the point of the screen — a worker pastes this straight into
 * WhatsApp. The text comes from the Clipboard Engine so it is identical wherever
 * it is produced.
 */
function PreparationOutput({
  result,
  onStartOver,
}: {
  result: PreparationResult;
  onStartOver: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const success = await copyToClipboard(result.clipboardText);

    if (!success) {
      toast.error("Could not copy", { description: "Your browser blocked clipboard access." });
      return;
    }

    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASING.out }}
      className="flex flex-col gap-5"
    >
      <div className="flex items-start gap-3 rounded-md border border-success/30 bg-success-subtle p-4">
        <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="text-card-title text-foreground">
            Prepared{result.customerIsNew ? " for a new customer" : ""}
          </p>
          <p className="text-caption text-foreground-muted">
            {formatPhoneForDisplay(result.customerPhone)} · {result.durationDays} days · expires{" "}
            {new Date(result.expirationDate).toLocaleDateString(undefined, { dateStyle: "medium" })}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-section-title text-foreground">Credentials</h2>
          <Button onClick={copy} className="gap-2">
            {copied ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy all"}
          </Button>
        </div>

        <pre className="overflow-x-auto rounded-md bg-background-secondary p-4 font-mono text-description whitespace-pre-wrap text-foreground">
          {result.clipboardText}
        </pre>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" asChild className="gap-2">
          <a href={result.whatsappUrl} target="_blank" rel="noopener noreferrer">
            <MessageCircle className="size-4" aria-hidden="true" />
            Open WhatsApp
          </a>
        </Button>

        <Button variant="ghost" onClick={onStartOver} className="gap-2">
          <RotateCcw className="size-4" aria-hidden="true" />
          Prepare another
        </Button>
      </div>
    </motion.div>
  );
}
