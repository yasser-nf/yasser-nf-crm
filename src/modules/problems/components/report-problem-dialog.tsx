"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ActionError } from "@/lib/errors";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Textarea } from "@/shared/ui/textarea";
import { reportProblemAction, type ActionResult } from "../actions/problem.actions";
import { PROBLEM_TYPE_LABELS } from "./problem-shared";

/**
 * Report a problem.
 *
 * One component, reused from Accounts, Profiles, Quick Prepare, the Customer
 * screen and the Problems screen — the five entry points the M08 brief lists.
 * All of them call the same Server Action and therefore the same service, so
 * the audit entry and the account-health consequence happen once regardless of
 * where the report came from.
 *
 * Reporting from a profile passes that profile's account: problems are account
 * grain, per 03_DATABASE.md and ADR-010 Decision 2.
 */

const formSchema = z.object({
  issueType: z.enum([
    "payment_problem",
    "incorrect_password",
    "invalid_email",
    "something_went_wrong",
    "other",
  ]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  description: z.string().trim().min(10, "Describe what went wrong").max(2000),
  assignToMe: z.boolean(),
});

type FormValues = z.infer<typeof formSchema>;

function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

export function ReportProblemDialog({
  accountId,
  accountEmail,
  trigger,
  onReported,
}: {
  accountId: string;
  accountEmail?: string;
  trigger?: React.ReactNode;
  onReported?: (problemId: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    control,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onTouched",
    defaultValues: {
      issueType: "something_went_wrong",
      severity: "medium",
      description: "",
      assignToMe: false,
    },
  });

  const report = useMutation({
    mutationFn: async (values: FormValues) =>
      unwrap(await reportProblemAction({ ...values, accountId })),
    onSuccess: ({ id }) => {
      toast.success("Problem reported", {
        description: "The account is now blocked from allocation until it is resolved.",
      });
      setOpen(false);
      reset();
      onReported?.(id);
      router.refresh();
    },
    onError: (error) => toast.error("Could not report", { description: error.userMessage }),
  });

  /* useWatch, not watch(): watch() returns a new function each render and stops React Compiler. */
  const issueType = useWatch({ control, name: "issueType" });
  const severity = useWatch({ control, name: "severity" });
  const assignToMe = useWatch({ control, name: "assignToMe" });

  if (!open) {
    return (
      <span onClick={() => setOpen(true)} role="presentation">
        {trigger ?? (
          <Button variant="outline" className="gap-2">
            <TriangleAlert className="size-4" aria-hidden="true" />
            Report problem
          </Button>
        )}
      </span>
    );
  }

  return (
    <form
      onSubmit={handleSubmit((values) => report.mutate(values))}
      noValidate
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-card-title text-foreground">Report a problem</h3>
        {accountEmail ? (
          <p className="text-caption text-foreground-subtle">{accountEmail}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="problem-type" className="text-description font-medium text-foreground">
          Problem type
        </Label>
        <Select
          value={issueType}
          onValueChange={(value) => setValue("issueType", value as FormValues["issueType"])}
          disabled={report.isPending}
        >
          <SelectTrigger id="problem-type" className="h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(PROBLEM_TYPE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="problem-severity" className="text-description font-medium text-foreground">
          Severity
        </Label>
        <Select
          value={severity}
          onValueChange={(value) => setValue("severity", value as FormValues["severity"])}
          disabled={report.isPending}
        >
          <SelectTrigger id="problem-severity" className="h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label
          htmlFor="problem-description"
          className="text-description font-medium text-foreground"
        >
          What happened
        </Label>
        <Textarea
          id="problem-description"
          rows={4}
          placeholder="What you saw, and what you were doing at the time."
          disabled={report.isPending}
          {...register("description")}
        />
        {errors.description ? (
          <p className="text-caption text-danger">{errors.description.message}</p>
        ) : null}
      </div>

      <label className="flex items-center gap-2 text-caption text-foreground-muted">
        <input
          type="checkbox"
          checked={assignToMe}
          onChange={(event) => setValue("assignToMe", event.target.checked)}
          disabled={report.isPending}
          className="size-4 rounded border-border"
        />
        Assign this to me
      </label>

      <div className="flex items-center justify-end gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setOpen(false)}
          disabled={report.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={report.isPending} className="min-w-36 gap-2">
          {report.isPending ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : null}
          Report problem
        </Button>
      </div>
    </form>
  );
}
