"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Eye, EyeOff, Info, LoaderCircle, ShieldCheck, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";

import { ROUTES } from "@/config/constants";
import { ROLE_LABELS, type UserRole } from "@/config/roles";
import { DURATION, EASING } from "@/config/theme";
import { ActionError } from "@/lib/errors";
import { FormField } from "@/shared/forms/form-field";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { createUserAction } from "../actions/user.actions";
import { buildCreateUserSchema, type CreateUserInput } from "../validation/create-user.schema";

/**
 * Create a user directly: name, email, password, role. ADR-014.
 *
 * The password lives in form state for the length of one submission and no
 * longer. It is cleared after every attempt, successful or not, so it is never
 * left sitting in the field, and nothing shows it after the user is created —
 * the server returns the stored row, which has no password in it.
 *
 * `assignableRoles` and `passwordMinLength` are resolved on the server. The
 * list only decides what is offered; the service re-checks the role and the
 * password against the same rules whatever this form sends.
 */
export function CreateUserForm({
  assignableRoles,
  passwordMinLength,
  creationConfigured,
}: {
  assignableRoles: readonly UserRole[];
  passwordMinLength: number;
  creationConfigured: boolean;
}) {
  const router = useRouter();
  const [passwordVisible, setPasswordVisible] = useState(false);

  const schema = useMemo(() => buildCreateUserSchema(passwordMinLength), [passwordMinLength]);

  const {
    register,
    handleSubmit,
    setValue,
    resetField,
    control,
    formState: { errors },
  } = useForm<CreateUserInput>({
    resolver: zodResolver(schema),
    mode: "onTouched",
    defaultValues: {
      name: "",
      email: "",
      password: "",
      role: assignableRoles.includes("worker") ? "worker" : (assignableRoles[0] ?? "worker"),
    },
  });

  const create = useMutation({
    mutationFn: async (values: CreateUserInput) => {
      const result = await createUserAction(values);

      if (!result.ok) {
        throw new ActionError(result.message, result.code, result.fieldErrors);
      }

      return result.data;
    },
    onSuccess: (user) => {
      toast.success("User created", {
        description: `${user.email} can sign in now with the password you set.`,
      });
      router.push(ROUTES.USERS);
      router.refresh();
    },
    onError: (error) => {
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not create user", { description: error.userMessage });
      }
    },
    onSettled: () => {
      /* Never left in the field: not after a refusal, not on the way out. */
      resetField("password", { defaultValue: "" });
      setPasswordVisible(false);
    },
  });

  const serverFieldErrors =
    create.error instanceof ActionError ? (create.error.fieldErrors ?? {}) : {};

  /*
   * useWatch rather than watch(). watch() returns a fresh function each render,
   * which React Compiler cannot memoize — it responds by skipping optimisation
   * for the whole component.
   */
  const role = useWatch({ control, name: "role" });

  const roleError = errors.role?.message ?? serverFieldErrors["role"];
  const disabled = create.isPending || !creationConfigured;

  return (
    <motion.form
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASING.out }}
      onSubmit={handleSubmit((values) => create.mutate(values))}
      noValidate
      autoComplete="off"
      className="flex max-w-xl flex-col gap-5 rounded-lg border border-border bg-surface p-6"
    >
      {!creationConfigured ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning-subtle p-4"
        >
          <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <p className="text-card-title text-foreground">User creation not configured</p>
            <p className="text-caption text-foreground-muted">
              Add <code className="font-mono">SUPABASE_SERVICE_ROLE_KEY</code> to{" "}
              <code className="font-mono">.env.local</code> to create users.
            </p>
          </div>
        </div>
      ) : null}

      <div className="flex items-start gap-3 rounded-md bg-background-secondary p-4">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <p className="text-caption text-foreground-muted">
          The password goes straight to Supabase Auth, which stores it hashed. The CRM does not keep
          it, and it is not shown again after the user is created — share it with them directly.
        </p>
      </div>

      <FormField
        label="Full name"
        placeholder="Amina Belkacem"
        disabled={disabled}
        error={errors.name?.message ?? serverFieldErrors["name"]}
        required
        {...register("name")}
      />

      <FormField
        label="Email"
        type="email"
        inputMode="email"
        autoComplete="off"
        placeholder="colleague@example.com"
        hint="They sign in with this address."
        disabled={disabled}
        error={errors.email?.message ?? serverFieldErrors["email"]}
        required
        {...register("email")}
      />

      <FormField
        label="Password"
        type={passwordVisible ? "text" : "password"}
        autoComplete="new-password"
        hint={`At least ${passwordMinLength} characters.`}
        disabled={disabled}
        error={errors.password?.message ?? serverFieldErrors["password"]}
        required
        trailing={
          <button
            type="button"
            onClick={() => setPasswordVisible((shown) => !shown)}
            aria-label={passwordVisible ? "Hide password" : "Show password"}
            className="text-foreground-subtle transition-colors hover:text-foreground"
          >
            {passwordVisible ? (
              <EyeOff className="size-4" aria-hidden="true" />
            ) : (
              <Eye className="size-4" aria-hidden="true" />
            )}
          </button>
        }
        {...register("password")}
      />

      <div className="flex flex-col gap-2">
        <Label htmlFor="create-user-role" className="text-description font-medium text-foreground">
          Role
        </Label>
        <Select
          value={role}
          onValueChange={(value) =>
            setValue("role", value as CreateUserInput["role"], { shouldValidate: true })
          }
          disabled={disabled}
        >
          <SelectTrigger id="create-user-role" className="h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {assignableRoles.map((option) => (
              <SelectItem key={option} value={option}>
                {ROLE_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {roleError ? (
          <p role="alert" className="text-caption text-danger">
            {roleError}
          </p>
        ) : (
          <p className="text-caption text-foreground-subtle">
            {role === "super_admin"
              ? "Full access, including user management and settings."
              : "Operational access only. Cannot delete accounts or manage users."}
          </p>
        )}
      </div>

      <div className="mt-2 flex items-center justify-end gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push(ROUTES.USERS)}
          disabled={create.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={disabled} className="min-w-40 gap-2">
          {create.isPending ? (
            <>
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Creating
            </>
          ) : (
            <>
              <UserPlus className="size-4" aria-hidden="true" />
              Create User
            </>
          )}
        </Button>
      </div>
    </motion.form>
  );
}
