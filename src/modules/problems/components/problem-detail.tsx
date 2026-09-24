"use client";

import { useMutation } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  CircleCheck,
  Clock,
  LoaderCircle,
  MessageSquare,
  RotateCcw,
  UserCheck,
  UserMinus,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { ROUTES } from "@/config/constants";
import { DURATION, EASING } from "@/config/theme";
import { ActionError } from "@/lib/errors";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";
import {
  addProblemNoteAction,
  assignProblemAction,
  cancelProblemAction,
  claimProblemAction,
  closeProblemAction,
  reopenProblemAction,
  resolveProblemAction,
  updateProblemAction,
  type ActionResult,
} from "../actions/problem.actions";
import type { ProblemListEntry } from "../repositories/problems.repository";
import { allowedTransitions, isBlocking, type ProblemStatus } from "../services/problem-lifecycle";
import type { TimelineEntry } from "../services/problem-timeline.service";
import {
  PROBLEM_TYPE_LABELS,
  ProblemStatusBadge,
  formatDateTime,
  problemAge,
} from "./problem-shared";

/**
 * Problem detail.
 *
 * Every control here is a convenience. The services refuse the same operations
 * independently — the transition graph, the ownership rule and the resolution
 * note are all enforced server-side, so removing a button changes what is easy,
 * not what is permitted.
 *
 * The buttons offered come from `allowedTransitions`, the same function the
 * service checks against. One definition, so the UI cannot offer a move the
 * server will reject.
 */

function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

export function ProblemDetailView({
  entry,
  timeline,
  viewer,
}: {
  entry: ProblemListEntry;
  timeline: readonly TimelineEntry[];
  viewer: { id: string; isSuperAdmin: boolean };
}) {
  const router = useRouter();
  const { problem } = entry;
  const [note, setNote] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [reopenReason, setReopenReason] = useState("");

  const isMine = problem.assignedTo === viewer.id;
  const mayMutate = viewer.isSuperAdmin || isMine;

  function refresh() {
    router.refresh();
  }

  const claim = useMutation({
    mutationFn: async () => unwrap(await claimProblemAction(problem.id)),
    onSuccess: () => {
      toast.success("Assigned to you");
      refresh();
    },
    onError: (error) => toast.error("Could not assign", { description: error.userMessage }),
  });

  const release = useMutation({
    mutationFn: async () => unwrap(await assignProblemAction(problem.id, null)),
    onSuccess: () => {
      toast.success("Unassigned");
      refresh();
    },
    onError: (error) => toast.error("Could not unassign", { description: error.userMessage }),
  });

  const changeStatus = useMutation({
    mutationFn: async (status: ProblemStatus) =>
      unwrap(await updateProblemAction(problem.id, { status })),
    onSuccess: () => {
      toast.success("Status updated");
      refresh();
    },
    onError: (error) => toast.error("Could not update", { description: error.userMessage }),
  });

  const resolve = useMutation({
    mutationFn: async () => unwrap(await resolveProblemAction(problem.id, resolutionNote)),
    onSuccess: () => {
      toast.success("Resolved", { description: "The account is allocatable again." });
      setResolutionNote("");
      refresh();
    },
    onError: (error) => toast.error("Could not resolve", { description: error.userMessage }),
  });

  const reopen = useMutation({
    mutationFn: async () => unwrap(await reopenProblemAction(problem.id, reopenReason)),
    onSuccess: ({ reopenCount }) => {
      toast.success(`Reopened (time ${reopenCount})`);
      setReopenReason("");
      refresh();
    },
    onError: (error) => toast.error("Could not reopen", { description: error.userMessage }),
  });

  const close = useMutation({
    mutationFn: async () => unwrap(await closeProblemAction(problem.id)),
    onSuccess: () => {
      toast.success("Closed");
      refresh();
    },
    onError: (error) => toast.error("Could not close", { description: error.userMessage }),
  });

  const cancel = useMutation({
    mutationFn: async () => unwrap(await cancelProblemAction(problem.id)),
    onSuccess: () => {
      toast.success("Cancelled");
      refresh();
    },
    onError: (error) => toast.error("Could not cancel", { description: error.userMessage }),
  });

  const addNote = useMutation({
    mutationFn: async () => unwrap(await addProblemNoteAction(problem.id, note)),
    onSuccess: () => {
      toast.success("Note added");
      setNote("");
      refresh();
    },
    onError: (error) => toast.error("Could not add note", { description: error.userMessage }),
  });

  const transitions = allowedTransitions(problem.status, viewer.isSuperAdmin);
  const simpleTransitions = transitions.filter(
    (status) => status !== "resolved" && status !== "open" && status !== "closed",
  );

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={ROUTES.PROBLEMS}
        className="inline-flex w-fit items-center gap-1.5 text-caption text-foreground-muted hover:text-foreground"
      >
        &larr; All problems
      </Link>

      <section className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-page-title text-foreground">
            {PROBLEM_TYPE_LABELS[problem.issueType] ?? problem.issueType}
          </h1>
          <ProblemStatusBadge status={problem.status} />
          {problem.reopenCount > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-warning-subtle px-2 py-1 text-caption text-warning">
              <RotateCcw className="size-3" aria-hidden="true" />
              Reopened {problem.reopenCount}×
            </span>
          ) : null}
        </div>

        {/*
          M03: the account and the problem. Severity and the free-text
          description are still stored and still in the timeline below; they are
          no longer what this screen leads with.

          "Account status" used to print the stored column, which reads
          "healthy" beside an open problem that is blocking that very account.
          Whether the account can sell is what an operator needs, and for this
          problem that is `isBlocking` — the same rule allocation applies.
        */}
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <dt className="text-caption text-foreground-subtle">Account</dt>
            <dd className="text-description">
              <Link
                href={`${ROUTES.ACCOUNTS}/${problem.accountId}`}
                className="break-all text-foreground hover:text-primary"
              >
                {entry.accountEmail}
              </Link>
            </dd>
          </div>
          <Field
            label="Blocking"
            value={isBlocking(problem.status) ? "Yes — the account cannot sell" : "No"}
          />
          <Field label="Assigned to" value={entry.assignedToName ?? "Unassigned"} />
          <Field label="Reported by" value={entry.reportedByName ?? "—"} />
          <Field label="Created" value={formatDateTime(problem.createdAt)} />
          <Field label="Updated" value={formatDateTime(problem.updatedAt)} />
          <Field label="Resolved" value={formatDateTime(problem.resolvedAt)} />
          <Field
            label="Age"
            value={problemAge(problem.createdAt, problem.resolvedAt, new Date())}
          />
        </dl>

        {/*
          Affected profiles are derived, never stored: an unhealthy account makes
          all five unavailable, which is already the documented business rule.
        */}
        {isBlocking(problem.status) ? (
          <p className="flex items-start gap-2 rounded-md bg-danger-subtle p-3 text-caption text-danger">
            <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            While this problem is {problem.status.replace(/_/g, " ")}, all five profiles on this
            account are blocked from allocation. Quick Prepare will not offer them.
          </p>
        ) : (
          <p className="flex items-start gap-2 rounded-md bg-background-secondary p-3 text-caption text-foreground-muted">
            <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            This problem no longer blocks the account. Any other open problem on it still would.
          </p>
        )}

        {problem.resolutionNote ? (
          <div className="flex flex-col gap-1 rounded-md border border-success/30 bg-success-subtle p-4">
            <span className="flex items-center gap-2 text-caption font-medium text-foreground">
              <CircleCheck className="size-3.5 text-success" aria-hidden="true" />
              Resolution
            </span>
            <p className="text-caption text-foreground-muted">{problem.resolutionNote}</p>
          </div>
        ) : null}

        {!mayMutate ? (
          <p className="rounded-md bg-background-secondary p-3 text-caption text-foreground-muted">
            This problem is not assigned to you, so it is read-only. Anyone can see every problem;
            only the assignee or a Super Admin can change one.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          {problem.assignedTo === null ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => claim.mutate()}
              disabled={claim.isPending}
              className="gap-2"
            >
              <UserCheck className="size-3.5" aria-hidden="true" />
              Assign to me
            </Button>
          ) : null}

          {mayMutate && problem.assignedTo !== null ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => release.mutate()}
              disabled={release.isPending}
              className="gap-2"
            >
              <UserMinus className="size-3.5" aria-hidden="true" />
              Unassign
            </Button>
          ) : null}

          {mayMutate
            ? simpleTransitions.map((status) => (
                <Button
                  key={status}
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    status === "cancelled" ? cancel.mutate() : changeStatus.mutate(status)
                  }
                  disabled={changeStatus.isPending || cancel.isPending}
                >
                  {status === "cancelled" ? "Cancel problem" : `Mark ${status.replace(/_/g, " ")}`}
                </Button>
              ))
            : null}

          {mayMutate && transitions.includes("closed") ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => close.mutate()}
              disabled={close.isPending}
            >
              Close
            </Button>
          ) : null}
        </div>

        {mayMutate && transitions.includes("resolved") ? (
          <div className="flex flex-col gap-2 rounded-md border border-border p-4">
            <span className="text-caption font-medium text-foreground">Resolve</span>
            <Textarea
              rows={3}
              value={resolutionNote}
              onChange={(event) => setResolutionNote(event.target.value)}
              placeholder="How was it fixed? The next person to hit this needs to know."
              disabled={resolve.isPending}
            />
            <div>
              <Button
                size="sm"
                onClick={() => resolve.mutate()}
                disabled={resolve.isPending || resolutionNote.trim().length < 10}
                className="gap-2"
              >
                {resolve.isPending ? (
                  <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <CircleCheck className="size-3.5" aria-hidden="true" />
                )}
                Resolve
              </Button>
            </div>
          </div>
        ) : null}

        {mayMutate && transitions.includes("open") ? (
          <div className="flex flex-col gap-2 rounded-md border border-border p-4">
            <span className="text-caption font-medium text-foreground">Reopen</span>
            <Textarea
              rows={2}
              value={reopenReason}
              onChange={(event) => setReopenReason(event.target.value)}
              placeholder="Why is it back?"
              disabled={reopen.isPending}
            />
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => reopen.mutate()}
                disabled={reopen.isPending || reopenReason.trim().length < 5}
                className="gap-2"
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
                Reopen
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-section-title text-foreground">Timeline</h2>

        {mayMutate ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
            <Textarea
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Add an internal note"
              disabled={addNote.isPending}
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-caption text-foreground-subtle">
                Notes are permanent and cannot be edited or deleted.
              </span>
              <Button
                size="sm"
                onClick={() => addNote.mutate()}
                disabled={addNote.isPending || note.trim().length === 0}
                className="gap-2"
              >
                <MessageSquare className="size-3.5" aria-hidden="true" />
                Add note
              </Button>
            </div>
          </div>
        ) : null}

        {timeline.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-description text-foreground-muted">
            Nothing recorded yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {timeline.map((event, index) => (
              <motion.li
                key={`${event.kind}-${event.id}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: DURATION.fast,
                  ease: EASING.standard,
                  delay: Math.min(index * 0.02, 0.15),
                }}
                className="flex flex-col gap-1 rounded-md bg-background-secondary px-4 py-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-caption">
                  <span className="text-foreground">{event.summary}</span>
                  <span className="text-foreground-subtle">
                    {event.actorName ?? "System"} · {formatDateTime(event.createdAt)}
                  </span>
                </div>
                {event.body ? (
                  <p className="text-caption text-foreground-muted">{event.body}</p>
                ) : null}
              </motion.li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-foreground-subtle">{label}</dt>
      <dd className="text-description text-foreground">{value}</dd>
    </div>
  );
}
