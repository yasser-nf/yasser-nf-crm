"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { motion } from "framer-motion";
import { Check, Eye, EyeOff, KeyRound, LoaderCircle, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import { DURATION, EASING } from "@/config/theme";
import { ValidationError } from "@/lib/errors";
import { FormField } from "@/shared/forms/form-field";
import { Button } from "@/shared/ui/button";
import { useChangePassword } from "../hooks/use-change-password";
import {
  buildChangePasswordSchema,
  type ChangePasswordInput,
} from "../validation/change-password.schema";

/**
 * Change your own password.
 *
 * Lives in the auth module because it is authentication, not configuration: the
 * Settings page composes it, exactly as it composes the other sections. Putting
 * it in the settings module would have made that module import the Supabase
 * browser client for one form.
 *
 * `passwordMinLength` is the CONFIGURED policy, resolved on the server and
 * passed in. The same number builds the schema the service revalidates with, so
 * the hint, the client rule and the server rule are one value.
 *
 * Nothing here logs, stores, or persists a password. The three values live in
 * the form state for the life of the interaction and are cleared on success.
 */
export function ChangePasswordForm({
  email,
  passwordMinLength,
}: {
  /** The signed-in user's address, for the re-authentication step. */
  email: string;
  passwordMinLength: number;
}) {
  const [visible, setVisible] = useState({ current: false, next: false, confirm: false });
  const [succeeded, setSucceeded] = useState(false);

  const schema = useMemo(() => buildChangePasswordSchema(passwordMinLength), [passwordMinLength]);
  const change = useChangePassword({ email, passwordMinLength });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ChangePasswordInput>({
    resolver: zodResolver(schema),
    mode: "onTouched",
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  /* Field messages the SERVER reported — a wrong current password arrives here. */
  const serverFieldErrors =
    change.error instanceof ValidationError ? (change.error.fieldErrors ?? {}) : {};

  function fieldError(name: keyof ChangePasswordInput): string | undefined {
    return (errors[name]?.message as string | undefined) ?? serverFieldErrors[name];
  }

  /* Only errors with nowhere better to go. Field-level ones render inline. */
  const formError =
    change.error && Object.keys(serverFieldErrors).length === 0 ? change.error.userMessage : null;

  const onSubmit = handleSubmit((values) => {
    setSucceeded(false);

    change.mutate(values, {
      onSuccess: () => {
        setSucceeded(true);
        /* Cleared immediately: there is no reason for them to stay in memory. */
        reset({ currentPassword: "", newPassword: "", confirmPassword: "" });
      },
    });
  });

  const toggle = (key: keyof typeof visible, label: string) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      tabIndex={-1}
      aria-label={visible[key] ? `Hide ${label}` : `Show ${label}`}
      onClick={() => setVisible((current) => ({ ...current, [key]: !current[key] }))}
      /* size-11 meets the 44x44 minimum touch target on mobile. */
      className="size-11 text-foreground-subtle hover:text-foreground"
    >
      {visible[key] ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
    </Button>
  );

  return (
    <section className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-6">
      <header className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <h2 className="text-section-title text-foreground">Change password</h2>
          <p className="text-description text-foreground-muted">
            Updates the password for <span className="text-foreground">{email}</span>. You will stay
            signed in on this device.
          </p>
        </div>
      </header>

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormField
          label="Current password"
          type={visible.current ? "text" : "password"}
          autoComplete="current-password"
          disabled={change.isPending}
          error={fieldError("currentPassword")}
          required
          trailing={toggle("current", "current password")}
          {...register("currentPassword")}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="New password"
            type={visible.next ? "text" : "password"}
            autoComplete="new-password"
            hint={`At least ${passwordMinLength} characters`}
            disabled={change.isPending}
            error={fieldError("newPassword")}
            required
            trailing={toggle("next", "new password")}
            {...register("newPassword")}
          />

          <FormField
            label="Confirm new password"
            type={visible.confirm ? "text" : "password"}
            autoComplete="new-password"
            disabled={change.isPending}
            error={fieldError("confirmPassword")}
            required
            trailing={toggle("confirm", "password confirmation")}
            {...register("confirmPassword")}
          />
        </div>

        {formError ? (
          <motion.p
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            transition={{ duration: DURATION.fast, ease: EASING.out }}
            role="alert"
            className="flex items-start gap-3 rounded-md border border-danger/30 bg-danger-subtle p-4 text-caption text-danger"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {formError}
          </motion.p>
        ) : null}

        {succeeded && !change.error ? (
          <motion.p
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            transition={{ duration: DURATION.fast, ease: EASING.out }}
            role="status"
            className="flex items-start gap-3 rounded-md border border-success/30 bg-success-subtle p-4 text-caption text-success"
          >
            <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Your password has been changed. Use the new one next time you sign in.
          </motion.p>
        ) : null}

        <Button
          type="submit"
          /* Disabled while in flight: one submission, not two. */
          disabled={change.isPending}
          className="h-11 w-full gap-2 sm:w-auto sm:self-start"
        >
          {change.isPending ? (
            <>
              <LoaderCircle className="animate-spin" aria-hidden="true" />
              Changing
            </>
          ) : (
            <>
              <KeyRound className="size-4" aria-hidden="true" />
              Change password
            </>
          )}
        </Button>
      </form>
    </section>
  );
}
