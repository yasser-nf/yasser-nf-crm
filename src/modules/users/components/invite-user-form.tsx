"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Info, LoaderCircle, Mail, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ROUTES } from "@/config/constants";
import { DURATION, EASING } from "@/config/theme";
import { ActionError } from "@/lib/errors";
import { FormField } from "@/shared/forms/form-field";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { inviteUserAction } from "../actions/user.actions";

/**
 * Invitation form.
 *
 * There is no password field, and there will never be one. ADR-008 Decision 2:
 * the CRM must never own a password. Supabase emails an invite and the person
 * sets their own — a form that could accept a password must not exist, because
 * its existence is what makes storing one possible.
 */

const formSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Email is required")
    .email("Enter a valid email address"),
  role: z.enum(["worker", "super_admin"]),
});

type FormValues = z.infer<typeof formSchema>;

export function InviteUserForm({ invitationsConfigured }: { invitationsConfigured: boolean }) {
  const router = useRouter();

  const invite = useMutation({
    mutationFn: async (values: FormValues) => {
      const result = await inviteUserAction(values);

      if (!result.ok) {
        throw new ActionError(result.message, result.code, result.fieldErrors);
      }

      return result.data;
    },
    onSuccess: (user) => {
      toast.success("Invitation sent", {
        description: `${user.email} will receive an email to set their password.`,
      });
      router.push(ROUTES.USERS);
      router.refresh();
    },
    onError: (error) => {
      if (!(error instanceof ActionError) || !error.fieldErrors) {
        toast.error("Could not send invitation", { description: error.userMessage });
      }
    },
  });

  const {
    register,
    handleSubmit,
    setValue,
    control,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onTouched",
    defaultValues: { name: "", email: "", role: "worker" },
  });

  const serverFieldErrors =
    invite.error instanceof ActionError ? (invite.error.fieldErrors ?? {}) : {};

  /*
   * useWatch rather than watch(). watch() returns a fresh function each render,
   * which React Compiler cannot memoize — it responds by skipping optimisation
   * for the whole component.
   */
  const role = useWatch({ control, name: "role" });

  return (
    <motion.form
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASING.out }}
      onSubmit={handleSubmit((values) => invite.mutate(values))}
      noValidate
      className="flex max-w-xl flex-col gap-5 rounded-lg border border-border bg-surface p-6"
    >
      {!invitationsConfigured ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning-subtle p-4"
        >
          <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <p className="text-card-title text-foreground">Invitations not configured</p>
            <p className="text-caption text-foreground-muted">
              Add <code className="font-mono">SUPABASE_SERVICE_ROLE_KEY</code> to{" "}
              <code className="font-mono">.env.local</code> to send invitations.
            </p>
          </div>
        </div>
      ) : null}

      <div className="flex items-start gap-3 rounded-md bg-background-secondary p-4">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <p className="text-caption text-foreground-muted">
          No password is set here. Supabase emails an invitation link and the person chooses their
          own password — the CRM never sees or stores it.
        </p>
      </div>

      <FormField
        label="Full name"
        placeholder="Amina Belkacem"
        disabled={invite.isPending}
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
        hint="The invitation is sent here."
        disabled={invite.isPending}
        error={errors.email?.message ?? serverFieldErrors["email"]}
        required
        {...register("email")}
      />

      <div className="flex flex-col gap-2">
        <Label htmlFor="invite-role" className="text-description font-medium text-foreground">
          Role
        </Label>
        <Select
          value={role}
          onValueChange={(value) => setValue("role", value as FormValues["role"])}
          disabled={invite.isPending}
        >
          <SelectTrigger id="invite-role" className="h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="worker">Worker</SelectItem>
            <SelectItem value="super_admin">Super Admin</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-caption text-foreground-subtle">
          {role === "super_admin"
            ? "Full access, including user management and settings."
            : "Operational access only. Cannot delete accounts or manage users."}
        </p>
      </div>

      <div className="mt-2 flex items-center justify-end gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push(ROUTES.USERS)}
          disabled={invite.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={invite.isPending} className="min-w-40 gap-2">
          {invite.isPending ? (
            <>
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Sending
            </>
          ) : (
            <>
              <Mail className="size-4" aria-hidden="true" />
              Send invitation
            </>
          )}
        </Button>
      </div>
    </motion.form>
  );
}
