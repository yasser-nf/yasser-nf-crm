"use client";

import { useMutation } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { ActionError } from "@/lib/errors";
import { resendInviteAction, type ActionResult } from "../actions/user.actions";

/*
 * The same conversion user-detail.tsx makes, kept local for the same reason:
 * a Server Action returns a plain object across the RSC boundary, and rebuilding
 * an ActionError from it is what lets react-query's error channel and the toast
 * read `userMessage` the way they do everywhere else.
 */
/**
 * The four outcomes a resend can have, as far as the operator is concerned.
 *
 * Keyed on the AppError code the Server Action carries across the boundary, not
 * on the message text — the same reason the service keys on Supabase's
 * error_code rather than its wording.
 */
const FAILURE_TITLES: Record<string, string> = {
  EXTERNAL_SERVICE_ERROR: "Invitation not sent",
  CONFLICT: "Already registered",
  VALIDATION_ERROR: "Address rejected",
  FORBIDDEN: "Not allowed",
};

function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

/**
 * Sends a fresh invitation to somebody who never accepted theirs.
 *
 * Offered only for a pending or expired invitation, and that is a courtesy
 * rather than the control: `usersService.resendInvite` re-derives eligibility
 * from Supabase and refuses an accepted user, so hiding this button is not what
 * stops the operation.
 *
 * The action takes the user's id alone. The email it sends to is read from the
 * stored row on the server, so nothing here can redirect an invitation.
 */
export function ResendInviteButton({
  userId,
  email,
  className,
}: {
  readonly userId: string;
  /** Shown in the confirmation so the operator sees who they are emailing. */
  readonly email: string;
  readonly className?: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);

  /*
   * The double-submit guard, and it has to be a ref.
   *
   * `resend.isPending` is read from the render that produced the handler, so
   * three clicks in one tick all see `false` — React has not re-rendered
   * between them, and neither has `disabled` taken effect. A ref is written and
   * read synchronously, which is the only thing fast enough to stop the second
   * click. `isPending` still drives what the button LOOKS like.
   */
  const inFlight = useRef(false);

  const resend = useMutation({
    mutationFn: async () => unwrap(await resendInviteAction(userId)),
    onSuccess: () => {
      inFlight.current = false;
      toast.success("Invitation resent successfully.");
      setConfirming(false);
      /*
       * Re-reads the list so the row shows the new invitation immediately —
       * an expired row becomes pending, dated from now. The action already
       * revalidated the path; this makes the open page pick it up.
       */
      router.refresh();
    },
    onError: (error) => {
      /* Cleared on BOTH paths, or a failed send leaves the button dead. */
      inFlight.current = false;

      /*
       * Titled by the error's CODE, described by its userMessage.
       *
       * The service maps Supabase's refusals onto distinct error classes, so
       * these read as different outcomes rather than one generic failure —
       * "wait a few minutes" and "that address is already registered" call for
       * completely different things from the operator.
       *
       * Only `userMessage` is ever rendered. The raw Supabase text can name
       * internals and never reaches the browser.
       */
      toast.error(FAILURE_TITLES[error.code] ?? "Could not resend the invitation", {
        description: error.userMessage,
      });
      setConfirming(false);
    },
  });

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(true)}
        disabled={resend.isPending}
        title={`Send a new invitation to ${email}`}
        aria-label={`Resend invitation to ${email}`}
        /* Subtle, but a real 44px target on a phone. */
        className={className ?? "h-11 gap-1.5 text-foreground-muted sm:h-8"}
      >
        <RefreshCw className="size-3.5" aria-hidden="true" />
        <span>Resend invite</span>
      </Button>

      <AlertDialog
        open={confirming}
        onOpenChange={(next) => {
          /* Not dismissible mid-flight, so a stray click cannot orphan the toast. */
          if (!resend.isPending) {
            setConfirming(next);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RefreshCw className="size-5 text-primary" aria-hidden="true" />
              Resend invitation?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will send a new invitation link to{" "}
              <span className="text-foreground">{email}</span>. Their previous invitation link will
              no longer be the one to use.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resend.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                /*
                 * Radix closes the dialog on action by default. Prevented so the
                 * button can stay visibly busy until the server answers — and so
                 * a second click has nothing to land on.
                 */
                event.preventDefault();

                if (inFlight.current) {
                  return;
                }

                inFlight.current = true;
                resend.mutate();
              }}
              disabled={resend.isPending}
            >
              {resend.isPending ? "Sending…" : "Resend invite"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
