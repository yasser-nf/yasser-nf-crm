"use client";

import { useId } from "react";

import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { cn } from "@/utils/cn";

/**
 * A labelled input with validation messaging.
 *
 * 04_UI_GUIDELINES.md requires every input to have a label, placeholder,
 * validation, error message, disabled state and focus state — and forbids
 * floating labels. Centralising that here is what stops the next form from
 * reinventing three quarters of it.
 */
export interface FormFieldProps extends Omit<React.ComponentProps<"input">, "id"> {
  readonly label: string;
  readonly error?: string | undefined;
  /** Explanatory text shown when there is no error. */
  readonly hint?: string | undefined;
  /** Rendered inside the field, against the trailing edge. */
  readonly trailing?: React.ReactNode;
}

export function FormField({
  label,
  error,
  hint,
  trailing,
  className,
  required,
  ...inputProps
}: FormFieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const hasError = Boolean(error);

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className="text-description font-medium text-foreground">
        {label}
        {required ? (
          <span className="text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
      </Label>

      <div className="relative">
        <Input
          id={id}
          required={required}
          aria-invalid={hasError}
          aria-describedby={error || hint ? messageId : undefined}
          className={cn(
            "h-11 rounded-md border-border bg-background-secondary text-foreground",
            "placeholder:text-foreground-subtle",
            "focus-visible:border-primary focus-visible:ring-primary/30",
            "disabled:cursor-not-allowed disabled:opacity-60",
            hasError && "border-danger focus-visible:border-danger focus-visible:ring-danger/30",
            trailing && "pr-11",
            className,
          )}
          {...inputProps}
        />

        {trailing ? (
          <div className="absolute inset-y-0 right-0 flex items-center pr-1">{trailing}</div>
        ) : null}
      </div>

      {error ? (
        <p id={messageId} role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={messageId} className="text-caption text-foreground-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
