"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { ActionError } from "@/lib/errors";
import { FormField } from "@/shared/forms/form-field";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";

/**
 * Supplier create and edit form. M10 §6 and §28.
 *
 * One component for both, because the fields are identical — the pattern
 * `AccountForm` already follows, and two near-identical forms would drift.
 *
 * The bounds below mirror `supplier.schema.ts`. That schema cannot be imported
 * here: it reaches `supplier-name.ts` through the module's own path, which is
 * fine, but the barrel that would make it an import is the one re-exporting
 * `server-only` services — the same constraint `QuickRenewScreen` and
 * `QuickReplaceScreen` declare their own form rules under. The server validates
 * every field again and its refusal renders on the matching input, so this copy
 * saves a round trip rather than being the check that matters.
 */

const MAX_NAME = 120;
const MAX_NOTES = 2000;

const supplierFormSchema = z.object({
  name: z
    .string()
    /* Collapsed here too, so the preview matches what the server will store. */
    .transform((value) => value.trim().replace(/\s+/g, " "))
    .refine((value) => value.length > 0, "Supplier name is required")
    .refine((value) => value.length <= MAX_NAME, `Limited to ${MAX_NAME} characters`),
  notes: z.string().trim().max(MAX_NOTES, `Limited to ${MAX_NOTES} characters`).optional(),
});

type SupplierFormValues = z.input<typeof supplierFormSchema>;

export function SupplierForm({
  mode,
  defaultName = "",
  defaultNotes = "",
  isSubmitting,
  error,
  onSubmit,
  onCancel,
}: {
  readonly mode: "create" | "edit";
  readonly defaultName?: string;
  readonly defaultNotes?: string;
  readonly isSubmitting: boolean;
  readonly error?: unknown;
  readonly onSubmit: (values: { name: string; notes?: string }) => void;
  readonly onCancel: () => void;
}) {
  const form = useForm<SupplierFormValues>({
    resolver: zodResolver(supplierFormSchema),
    mode: "onTouched",
    defaultValues: { name: defaultName, notes: defaultNotes },
  });

  /* A duplicate name comes back as a field error and renders on the input. */
  const serverFieldErrors = error instanceof ActionError ? (error.fieldErrors ?? {}) : {};

  const fieldError = (name: "name" | "notes"): string | undefined =>
    (form.formState.errors[name]?.message as string | undefined) ?? serverFieldErrors[name];

  const submit = form.handleSubmit((values) => {
    onSubmit({
      name: values.name.trim().replace(/\s+/g, " "),
      /* An empty note clears it, so "" is sent rather than dropped. */
      notes: values.notes ?? "",
    });
  });

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <FormField
        label="Supplier name"
        placeholder="NetStore DZ"
        autoComplete="off"
        maxLength={MAX_NAME}
        disabled={isSubmitting}
        error={fieldError("name")}
        hint="Case and extra spaces are ignored when checking for duplicates."
        required
        {...form.register("name")}
      />

      <div className="flex flex-col gap-2">
        <Label htmlFor="supplier-notes" className="text-description font-medium text-foreground">
          Notes
        </Label>
        <Textarea
          id="supplier-notes"
          rows={3}
          maxLength={MAX_NOTES}
          placeholder="How to reach them, payment terms, anything worth remembering."
          disabled={isSubmitting}
          aria-invalid={Boolean(fieldError("notes"))}
          {...form.register("notes")}
        />
        {fieldError("notes") ? (
          <p role="alert" className="text-caption text-danger">
            {fieldError("notes")}
          </p>
        ) : (
          <p className="text-caption text-foreground-subtle">
            Optional. Never store passwords or payment credentials here.
          </p>
        )}
      </div>

      {/* A refusal that names no field still has to be shown. */}
      {error instanceof ActionError && !error.fieldErrors ? (
        <p role="alert" className="text-caption text-danger">
          {error.userMessage}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button
          type="submit"
          loading={isSubmitting}
          loadingLabel={mode === "create" ? "Creating" : "Saving"}
          className="min-w-32"
        >
          {mode === "create" ? "Create supplier" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
