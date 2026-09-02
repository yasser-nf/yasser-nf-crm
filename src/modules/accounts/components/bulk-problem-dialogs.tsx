"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Label } from "@/shared/ui/label";
import { PROBLEM_TYPE_LABELS } from "@/shared/ui/problem-badges";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Textarea } from "@/shared/ui/textarea";
import { useDeclareProblems, useResolveProblems } from "../hooks/use-bulk-problem-mutations";

/**
 * Declaring and resolving problems for a selection of accounts.
 *
 * Presentation only. Every rule these dialogs appear to enforce — that a
 * description is required, that a resolution note is required, who may resolve
 * what — belongs to the problems module and is enforced there. The form asks
 * for the same fields the single-account screens ask for so the operator is not
 * offered a cheaper way in: acting on ten accounts is not a reason to accept a
 * blank note that would leave ten rows claiming a resolution nobody explained.
 *
 * These live in the accounts module rather than beside the problem screens
 * because a client component may only import actions from its own module. The
 * work still happens in the problems module, one service call away.
 */

interface BulkProblemProps {
  /** Accounts this action applies to. Already narrowed by the caller. */
  readonly accountIds: readonly string[];
  /** Called after a run that changed at least one account. */
  readonly onDone: () => void;
}

/* ------------------------------------------------------------------ declare */

interface DeclareValues {
  issueType: string;
  severity: string;
  description: string;
  assignToMe: boolean;
}

export function BulkDeclareProblemDialog({ accountIds, onDone }: BulkProblemProps) {
  const [open, setOpen] = useState(false);
  const declare = useDeclareProblems();

  const { register, handleSubmit, setValue, control, reset, formState } = useForm<DeclareValues>({
    mode: "onTouched",
    defaultValues: {
      issueType: "something_went_wrong",
      severity: "medium",
      description: "",
      assignToMe: false,
    },
  });

  /* useWatch, not watch(): watch() returns a new function each render and stops React Compiler. */
  const issueType = useWatch({ control, name: "issueType" });
  const severity = useWatch({ control, name: "severity" });
  const assignToMe = useWatch({ control, name: "assignToMe" });

  const count = accountIds.length;

  if (count === 0) {
    return null;
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        loading={declare.isPending}
        loadingLabel="Declaring"
        className="gap-2 text-warning hover:bg-warning-subtle hover:text-warning"
      >
        <TriangleAlert className="size-4" aria-hidden="true" />
        Declare problem
      </Button>

      <Dialog
        open={open}
        /* A run in flight cannot be dismissed: closing would hide it, not stop it. */
        onOpenChange={(next) => {
          if (!declare.isPending) {
            setOpen(next);
          }
        }}
      >
        <DialogContent>
          <form
            onSubmit={handleSubmit((form) => {
              /* The disabled button is the real guard; this catches a key repeat. */
              if (declare.isPending) {
                return;
              }

              declare.mutate(
                { ids: accountIds, input: form },
                {
                  onSuccess: () => {
                    setOpen(false);
                    reset();
                    onDone();
                  },
                },
              );
            })}
            noValidate
            className="flex flex-col gap-4"
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <TriangleAlert className="size-5 text-warning" aria-hidden="true" />
                Declare a problem on {count} account{count === 1 ? "" : "s"}?
              </DialogTitle>
              <DialogDescription>
                The same problem is opened against each selected account. Every one of them stops
                being available for allocation until it is resolved.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-2">
              <Label htmlFor="bulk-problem-type">Problem type</Label>
              <Select
                value={issueType}
                onValueChange={(value) => setValue("issueType", value)}
                disabled={declare.isPending}
              >
                <SelectTrigger id="bulk-problem-type" className="h-11 w-full">
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
              <Label htmlFor="bulk-problem-severity">Severity</Label>
              <Select
                value={severity}
                onValueChange={(value) => setValue("severity", value)}
                disabled={declare.isPending}
              >
                <SelectTrigger id="bulk-problem-severity" className="h-11 w-full">
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
              <Label htmlFor="bulk-problem-description">What happened</Label>
              <Textarea
                id="bulk-problem-description"
                rows={4}
                placeholder="What you saw, and what you were doing at the time."
                disabled={declare.isPending}
                {...register("description", {
                  required: "Describe what went wrong",
                  minLength: { value: 10, message: "Describe what went wrong in a few more words" },
                })}
              />
              {formState.errors.description ? (
                <p className="text-caption text-danger">{formState.errors.description.message}</p>
              ) : null}
            </div>

            <label className="flex items-center gap-2 text-caption text-foreground-muted">
              <Checkbox
                checked={assignToMe}
                onCheckedChange={(checked) => setValue("assignToMe", checked === true)}
                disabled={declare.isPending}
                aria-label="Assign these problems to me"
              />
              Assign them to me
            </label>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={declare.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" loading={declare.isPending} loadingLabel="Declaring">
                Declare problem
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ resolve */

interface ResolveValues {
  resolutionNote: string;
}

export function BulkResolveProblemsDialog({ accountIds, onDone }: BulkProblemProps) {
  const [open, setOpen] = useState(false);
  const resolve = useResolveProblems();

  const { register, handleSubmit, reset, formState } = useForm<ResolveValues>({
    mode: "onTouched",
    defaultValues: { resolutionNote: "" },
  });

  const count = accountIds.length;

  if (count === 0) {
    return null;
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        loading={resolve.isPending}
        loadingLabel="Resolving"
        className="gap-2 text-success hover:bg-success-subtle hover:text-success"
      >
        <CircleCheck className="size-4" aria-hidden="true" />
        Resolve
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!resolve.isPending) {
            setOpen(next);
          }
        }}
      >
        <DialogContent>
          <form
            onSubmit={handleSubmit((form) => {
              if (resolve.isPending) {
                return;
              }

              resolve.mutate(
                { ids: accountIds, input: form },
                {
                  onSuccess: () => {
                    setOpen(false);
                    reset();
                    onDone();
                  },
                },
              );
            })}
            noValidate
            className="flex flex-col gap-4"
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CircleCheck className="size-5 text-success" aria-hidden="true" />
                Resolve {count} account{count === 1 ? "" : "s"}?
              </DialogTitle>
              <DialogDescription>
                Every open problem on the selected accounts is marked resolved, and they become
                available for allocation again.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-2">
              <Label htmlFor="bulk-resolution-note">How it was resolved</Label>
              <Textarea
                id="bulk-resolution-note"
                rows={4}
                placeholder="What you did to fix it."
                disabled={resolve.isPending}
                {...register("resolutionNote", {
                  required: "Explain how it was resolved",
                  minLength: {
                    value: 10,
                    message: "Explain how it was resolved — the next person to hit this needs it",
                  },
                })}
              />
              {formState.errors.resolutionNote ? (
                <p className="text-caption text-danger">
                  {formState.errors.resolutionNote.message}
                </p>
              ) : null}
              <p className="text-caption text-foreground-subtle">
                The same note is recorded on every problem being resolved.
              </p>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={resolve.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" loading={resolve.isPending} loadingLabel="Resolving">
                Resolve problems
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
