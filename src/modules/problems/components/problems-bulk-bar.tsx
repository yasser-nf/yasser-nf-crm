"use client";

import { useMutation } from "@tanstack/react-query";
import { CircleCheck, Trash2, TriangleAlert, UserCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { ActionError } from "@/lib/errors";
import { BulkActionBar } from "@/shared/ui/bulk-action-bar";
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
import { Textarea } from "@/shared/ui/textarea";
import {
  assignProblemsAction,
  deleteProblemsAction,
  resolveProblemsAction,
  type ActionResult,
} from "../actions/problem.actions";
import type { ProblemBulkOutcome } from "../services/bulk-problems.service";
import { isBlocking, type ProblemStatus } from "../services/problem-lifecycle";

/**
 * The Problems page's bulk toolbar (M03) — the same frame as the Accounts one.
 *
 * Resolve, Assign and Delete each send the selected problem ids to a server
 * action that re-reads every problem and runs the existing per-problem service
 * on it. What is offered here follows the viewer's role; what is permitted is
 * decided on the server, problem by problem, and reported back.
 */

export interface SelectedProblem {
  readonly id: string;
  readonly status: ProblemStatus;
}

export interface Assignee {
  readonly id: string;
  readonly name: string;
}

/** "3 problems selected". */
export function problemSelectionLabel(count: number): string {
  return `${count} problem${count === 1 ? "" : "s"} selected`;
}

/**
 * One sentence for what a bulk action did.
 *
 *   "4 problems resolved."
 *   "3 resolved, 1 skipped (Already closed.)."
 *   "2 resolved, 1 failed: You can only work on problems assigned to you."
 *
 * Exported so the wording is asserted rather than paraphrased.
 */
export function describeOutcome(verb: string, outcome: ProblemBulkOutcome): string {
  const done = outcome.succeeded.length;
  const parts: string[] = [];

  if (outcome.skipped.length === 0 && outcome.failed.length === 0) {
    return `${done} problem${done === 1 ? "" : "s"} ${verb}.`;
  }

  parts.push(`${done} ${verb}`);

  if (outcome.skipped.length > 0) {
    parts.push(`${outcome.skipped.length} skipped (${outcome.skipped[0]?.reason ?? ""})`);
  }

  if (outcome.failed.length > 0) {
    parts.push(`${outcome.failed.length} failed: ${outcome.failed[0]?.message ?? ""}`);
  }

  const sentence = parts.join(", ");
  /* A server message usually ends in a full stop already; never print two. */
  return sentence.endsWith(".") ? sentence : `${sentence}.`;
}

function reportOutcome(verb: string, outcome: ProblemBulkOutcome) {
  const message = describeOutcome(verb, outcome);

  if (outcome.failed.length > 0) {
    toast.warning(message);
  } else {
    toast.success(message);
  }
}

function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

export function ProblemsBulkBar({
  problems,
  assignees,
  canAssign,
  canDelete,
  onClear,
}: {
  /** The selected rows on this page, in display order. */
  readonly problems: readonly SelectedProblem[];
  /** People a problem may be assigned to. */
  readonly assignees: readonly Assignee[];
  /** Assigning to someone else — Super Admin. Workers claim from the detail page. */
  readonly canAssign: boolean;
  /** MANAGE_PROBLEMS — Super Admin. */
  readonly canDelete: boolean;
  readonly onClear: () => void;
}) {
  const [dialog, setDialog] = useState<"resolve" | "assign" | "delete" | null>(null);

  const ids = problems.map((problem) => problem.id);
  const resolvable = problems.filter((problem) => isBlocking(problem.status)).length;

  if (ids.length === 0) {
    return null;
  }

  const close = () => setDialog(null);
  const done = () => {
    setDialog(null);
    onClear();
  };

  return (
    <>
      <BulkActionBar count={ids.length} label={problemSelectionLabel(ids.length)} onClear={onClear}>
        {/*
          Disabled when nothing selected is still blocking: resolving a
          resolved or closed problem would do nothing, and must never reopen it.
        */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDialog("resolve")}
          disabled={resolvable === 0}
          title={resolvable === 0 ? "Every selected problem is already finished." : undefined}
          className="gap-2 text-success hover:bg-success-subtle hover:text-success"
        >
          <CircleCheck className="size-4" aria-hidden="true" />
          Resolve
        </Button>

        {canAssign ? (
          <Button variant="ghost" size="sm" onClick={() => setDialog("assign")} className="gap-2">
            <UserCheck className="size-4" aria-hidden="true" />
            Assign
          </Button>
        ) : null}

        {canDelete ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDialog("delete")}
            className="gap-2 text-danger hover:bg-danger-subtle hover:text-danger"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Delete
          </Button>
        ) : null}
      </BulkActionBar>

      {dialog === "resolve" ? (
        <ResolveDialog ids={ids} resolvable={resolvable} onClose={close} onDone={done} />
      ) : null}
      {dialog === "assign" ? (
        <AssignDialog ids={ids} assignees={assignees} onClose={close} onDone={done} />
      ) : null}
      {dialog === "delete" ? <DeleteDialog ids={ids} onClose={close} onDone={done} /> : null}
    </>
  );
}

/* ---------------------------------------------------------------- resolve */

function ResolveDialog({
  ids,
  resolvable,
  onClose,
  onDone,
}: {
  readonly ids: readonly string[];
  readonly resolvable: number;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const finished = ids.length - resolvable;

  const resolve = useMutation({
    mutationFn: async () =>
      unwrap(await resolveProblemsAction([...ids], { resolutionNote: note.trim() })),
    onSuccess: (outcome) => {
      reportOutcome("resolved", outcome);
      router.refresh();
      onDone();
    },
    onError: (error) => toast.error("Could not resolve", { description: error.userMessage }),
  });

  /* The existing rule, stated before the round trip: resolving needs an explanation. */
  const noteTooShort = note.trim().length < 10;

  return (
    <Dialog open onOpenChange={(next) => !next && !resolve.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Resolve {resolvable} problem{resolvable === 1 ? "" : "s"}?
          </DialogTitle>
          <DialogDescription>
            Each is resolved exactly as it would be on its own page, with this note. An account
            whose last blocking problem this is returns to Accounts.
            {finished > 0
              ? ` ${finished} selected problem${finished === 1 ? " is" : "s are"} already finished and will be skipped, not reopened.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="bulk-resolution-note">How it was resolved</Label>
          <Textarea
            id="bulk-resolution-note"
            rows={3}
            value={note}
            disabled={resolve.isPending}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What fixed it — the next person to hit this needs to know."
          />
          <p className="text-caption text-foreground-subtle">At least 10 characters.</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={resolve.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => resolve.mutate()}
            disabled={noteTooShort}
            loading={resolve.isPending}
            loadingLabel="Resolving"
          >
            Resolve problems
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------------- assign */

function AssignDialog({
  ids,
  assignees,
  onClose,
  onDone,
}: {
  readonly ids: readonly string[];
  readonly assignees: readonly Assignee[];
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const [assignee, setAssignee] = useState("");
  const chosen = assignees.find((person) => person.id === assignee);

  const assign = useMutation({
    mutationFn: async () => unwrap(await assignProblemsAction([...ids], { assignedTo: assignee })),
    onSuccess: (outcome) => {
      reportOutcome("assigned", outcome);
      router.refresh();
      onDone();
    },
    onError: (error) => toast.error("Could not assign", { description: error.userMessage }),
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !assign.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Assign {ids.length} problem{ids.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            Every selected problem is assigned to the person you choose. Closed and cancelled
            problems cannot be assigned and are reported rather than changed.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="bulk-assignee">Assign to</Label>
          <select
            id="bulk-assignee"
            value={assignee}
            onChange={(event) => setAssignee(event.target.value)}
            disabled={assign.isPending}
            className="h-11 rounded-md border border-border bg-surface px-3 text-description text-foreground"
          >
            <option value="">Choose a person</option>
            {assignees.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={assign.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => assign.mutate()}
            disabled={!chosen}
            loading={assign.isPending}
            loadingLabel="Assigning"
          >
            {chosen ? `Assign to ${chosen.name}` : "Assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------------- delete */

function DeleteDialog({
  ids,
  onClose,
  onDone,
}: {
  readonly ids: readonly string[];
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const [understood, setUnderstood] = useState(false);
  const count = ids.length;

  const remove = useMutation({
    mutationFn: async () => unwrap(await deleteProblemsAction([...ids])),
    onSuccess: (outcome) => {
      reportOutcome("deleted", outcome);
      router.refresh();
      onDone();
    },
    onError: (error) => toast.error("Could not delete", { description: error.userMessage }),
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !remove.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-5 text-danger" aria-hidden="true" />
            Delete {count} problem{count === 1 ? "" : "s"}?
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-2">
              <p>
                This affects all {count} selected problem record{count === 1 ? "" : "s"}.
              </p>
              <p>
                Each problem and its problem notes are removed permanently. The accounts, their
                profiles and their customers are not touched. An account left with no blocking
                problem returns to Accounts. The deletion itself stays in the audit log.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <label className="flex items-start gap-2 text-caption text-foreground">
          <Checkbox
            checked={understood}
            onCheckedChange={(checked) => setUnderstood(checked === true)}
            disabled={remove.isPending}
            aria-label={`I understand ${count} problems will be deleted`}
          />
          <span>
            I understand {count} problem{count === 1 ? "" : "s"} will be deleted.
          </span>
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => remove.mutate()}
            disabled={!understood}
            loading={remove.isPending}
            loadingLabel="Deleting"
            className="bg-danger text-white hover:bg-danger/90"
          >
            Delete {count} problem{count === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
