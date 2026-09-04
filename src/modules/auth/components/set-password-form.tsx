"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import { ValidationError } from "@/lib/errors";
import { FormField } from "@/shared/forms/form-field";
import { Button } from "@/shared/ui/button";
import { useSetPassword } from "../hooks/use-set-password";
import { buildSetPasswordSchema, type SetPasswordInput } from "../validation/set-password.schema";

/**
 * Choose your first password, after accepting an invitation.
 *
 * Two fields, not three: there is no current password to prove. What stands in
 * for that proof is the session, which exists only because Supabase verified a
 * single-use invitation token minutes earlier — and `setInitialPassword`
 * refuses without one.
 *
 * `passwordMinLength` is the configured policy, resolved on the server and
 * passed in, so the hint, the client rule and the server rule are one value.
 *
 * Nothing here logs or persists a password; the values live in form state for
 * the life of the interaction.
 */
export function SetPasswordForm({ passwordMinLength }: { passwordMinLength: number }) {
  const [visible, setVisible] = useState({ next: false, confirm: false });

  const schema = useMemo(() => buildSetPasswordSchema(passwordMinLength), [passwordMinLength]);
  const set = useSetPassword({ passwordMinLength });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SetPasswordInput>({
    resolver: zodResolver(schema),
    mode: "onTouched",
    defaultValues: { newPassword: "", confirmPassword: "" },
  });

  const serverFieldErrors =
    set.error instanceof ValidationError ? (set.error.fieldErrors ?? {}) : {};

  function fieldError(name: keyof SetPasswordInput): string | undefined {
    return (errors[name]?.message as string | undefined) ?? serverFieldErrors[name];
  }

  /*
   * Only errors with nowhere better to go. An expired session lands here — it
   * is not any one field's fault, and it is the message that tells somebody
   * their link has gone stale.
   */
  const formError =
    set.error && Object.keys(serverFieldErrors).length === 0 ? set.error.userMessage : null;

  const onSubmit = handleSubmit((values) => set.mutate(values));

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <div className="flex flex-col gap-4">
        <FormField
          label="New password"
          type={visible.next ? "text" : "password"}
          autoComplete="new-password"
          autoFocus
          hint={`At least ${passwordMinLength} characters.`}
          disabled={set.isPending}
          error={fieldError("newPassword")}
          trailing={
            <VisibilityToggle
              shown={visible.next}
              onToggle={() => setVisible((v) => ({ ...v, next: !v.next }))}
            />
          }
          {...register("newPassword")}
        />

        <FormField
          label="Confirm password"
          type={visible.confirm ? "text" : "password"}
          autoComplete="new-password"
          disabled={set.isPending}
          error={fieldError("confirmPassword")}
          trailing={
            <VisibilityToggle
              shown={visible.confirm}
              onToggle={() => setVisible((v) => ({ ...v, confirm: !v.confirm }))}
            />
          }
          {...register("confirmPassword")}
        />
      </div>

      {formError ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle p-3 text-caption text-danger"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{formError}</span>
        </p>
      ) : null}

      <Button type="submit" loading={set.isPending} className="w-full">
        Set password and continue
      </Button>
    </form>
  );
}

function VisibilityToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const Icon = shown ? EyeOff : Eye;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={shown ? "Hide password" : "Show password"}
      className="text-foreground-subtle transition-colors hover:text-foreground"
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}
