"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { motion } from "framer-motion";
import { Eye, EyeOff, LoaderCircle, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { isSupabaseConfigured } from "@/config/env";
import { DURATION, EASING } from "@/config/theme";
import { ValidationError } from "@/lib/errors";
import { Button } from "@/shared/ui/button";
import { FormField } from "@/shared/forms/form-field";
import { useLogin } from "../hooks/use-login";
import { loginSchema, type LoginInput } from "../validation/login.schema";

/**
 * Sign-in form.
 *
 * 02_ARCHITECTURE.md: business logic never lives in a component. This renders
 * and collects input; `authService` decides whether the credentials are valid.
 */
export function LoginForm() {
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const login = useLogin();
  const supabaseConfigured = isSupabaseConfigured();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    // 04_UI_GUIDELINES.md: validate immediately after interaction.
    mode: "onTouched",
    defaultValues: { email: "", password: "" },
  });

  /*
   * Field-level errors raised by the service are merged with the form's own, so
   * server-side validation surfaces on the field it belongs to rather than as a
   * detached banner.
   */
  const serviceFieldErrors =
    login.error instanceof ValidationError ? (login.error.fieldErrors ?? {}) : {};

  const emailError = errors.email?.message ?? serviceFieldErrors["email"];
  const passwordError = errors.password?.message ?? serviceFieldErrors["password"];

  const showFormError = login.isError && !(login.error instanceof ValidationError);
  const isSubmitting = login.isPending;

  return (
    <motion.form
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.slow, ease: EASING.out }}
      onSubmit={handleSubmit((values) => login.mutate(values))}
      noValidate
      className="flex flex-col gap-6"
    >
      {!supabaseConfigured ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning-subtle p-4"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <p className="text-card-title text-foreground">Connection not configured</p>
            <p className="text-caption text-foreground-muted">
              Add your Supabase credentials to <code className="font-mono">.env.local</code> to
              enable sign-in.
            </p>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        <FormField
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="username"
          placeholder="you@example.com"
          disabled={isSubmitting}
          error={emailError}
          required
          {...register("email")}
        />

        <FormField
          label="Password"
          type={isPasswordVisible ? "text" : "password"}
          autoComplete="current-password"
          placeholder="Enter your password"
          disabled={isSubmitting}
          error={passwordError}
          required
          trailing={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              tabIndex={-1}
              aria-label={isPasswordVisible ? "Hide password" : "Show password"}
              onClick={() => setIsPasswordVisible((visible) => !visible)}
              // size-11 meets the 44x44 minimum touch target on mobile.
              className="size-11 text-foreground-subtle hover:text-foreground"
            >
              {isPasswordVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </Button>
          }
          {...register("password")}
        />
      </div>

      {showFormError ? (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          transition={{ duration: DURATION.fast }}
          role="alert"
          className="flex items-start gap-3 rounded-md border border-danger/30 bg-danger-subtle p-4"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          <div className="flex flex-col gap-2">
            {/* Never a stack trace — userMessage is the only renderable text. */}
            <p className="text-description text-foreground">{login.error.userMessage}</p>
            <button
              type="submit"
              // min-h-11 keeps this recovery action tappable at the 44px minimum.
              className="inline-flex min-h-11 items-center self-start text-caption font-medium text-primary underline-offset-4 hover:underline"
            >
              Try again
            </button>
          </div>
        </motion.div>
      ) : null}

      <Button type="submit" size="lg" disabled={isSubmitting} className="h-11 w-full">
        {isSubmitting ? (
          <>
            <LoaderCircle className="animate-spin" aria-hidden="true" />
            Signing in
          </>
        ) : (
          "Sign in"
        )}
      </Button>
    </motion.form>
  );
}
