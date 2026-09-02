"use client";

import { Pencil } from "lucide-react";
import { useState } from "react";

import { Button } from "@/shared/ui/button";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/utils/cn";
import { useUpdateAccount } from "../hooks/use-account-mutations";

/**
 * The account note, read and written from wherever the operator is standing.
 *
 * One column — `accounts.notes` — behind both the list and the detail page, so
 * the two cannot disagree and no migration was needed. The account already had
 * this field; what it lacked was anywhere to see or change it without opening
 * the full edit form, which is what made short operational notes impractical.
 *
 * Writes go through `useUpdateAccount`, the same hook the edit form uses, so
 * there is no second way to change an account and the permission check, the
 * audit entry and the revalidation of both routes all happen exactly once.
 * Revalidating both is what keeps the list and the detail page in step.
 */

/** Notes are informational. Nothing downstream reads them. */
const NOTE_MAX = 2000;

export function AccountNoteCell({
  accountId,
  accountEmail,
  note,
  className,
  variant = "compact",
}: {
  readonly accountId: string;
  readonly accountEmail: string;
  readonly note: string | null;
  readonly className?: string;
  /**
   * "compact" truncates to one line for the table; "full" wraps.
   *
   * A detail page has room to show the whole note and is where somebody goes to
   * read it, so truncating there would hide the thing they came for. Same
   * component either way, so the two surfaces cannot drift apart.
   */
  readonly variant?: "compact" | "full";
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(note ?? "");
  const update = useUpdateAccount(accountId);

  const trimmed = (note ?? "").trim();
  const hasNote = trimmed.length > 0;

  function start() {
    /*
     * The draft is seeded when the dialog opens, not held in sync with the row.
     * Reseeding on every render would discard what the operator was typing the
     * moment anything else refreshed the list.
     */
    setDraft(note ?? "");
    setOpen(true);
  }

  function save() {
    /* The disabled button is the real guard; this catches a keyboard repeat. */
    if (update.isPending) {
      return;
    }

    /*
     * Trimmed, and an empty note is sent as an empty string rather than being
     * dropped from the payload — omitting it would mean "unchanged", which is
     * the opposite of clearing it.
     */
    update.mutate(
      { notes: draft.trim() },
      {
        onSuccess: () => setOpen(false),
      },
    );
  }

  return (
    <>
      <div className={cn("flex items-center gap-1", className)}>
        {hasNote && variant === "full" ? (
          <p className="text-description whitespace-pre-wrap text-foreground-muted">{trimmed}</p>
        ) : hasNote ? (
          /*
           * The provider lives here rather than in a layout because this is the
           * first tooltip in the application and the cell is rendered from three
           * places. Self-contained means no caller has to remember to add one,
           * and nesting providers is harmless.
           */
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                {/*
                Truncated rather than wrapped, with a fixed maximum, so one long
                note cannot widen the column and push the table sideways. The
                full text is a hover away and always readable in the dialog.
              */}
                <span className="max-w-[14rem] truncate text-caption text-foreground-muted">
                  {trimmed}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p className="whitespace-pre-wrap">{trimmed}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <span className="text-caption text-foreground-subtle">—</span>
        )}

        <Button
          variant="ghost"
          size="icon-xs"
          onClick={start}
          loading={update.isPending}
          aria-label={hasNote ? `Edit note for ${accountEmail}` : `Add note for ${accountEmail}`}
          /*
           * 24px of button, expanded to the 44px touch target
           * 04_UI_GUIDELINES.md requires — but only below lg, where the mobile
           * cards render. The pseudo element belongs to the button, so every
           * pixel of it is the button; a padded wrapper would hit-test as the
           * wrapper and do nothing.
           *
           * Switched off at lg and above, because that is where the dense table
           * renders and a 10px halo around this pencil would reach into the
           * Copy actions beside it.
           */
          className="relative shrink-0 text-foreground-subtle before:absolute before:-inset-2.5 before:content-[''] hover:text-foreground lg:before:content-none"
        >
          <Pencil aria-hidden="true" />
        </Button>
      </div>

      <Dialog
        open={open}
        /* A save in flight cannot be dismissed: closing would hide it, not stop it. */
        onOpenChange={(next) => {
          if (!update.isPending) {
            setOpen(next);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Note</DialogTitle>
            <DialogDescription className="break-all">{accountEmail}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="account-note">Internal note</Label>
            <Textarea
              id="account-note"
              rows={3}
              maxLength={NOTE_MAX}
              autoFocus
              placeholder="Profile 1 opened · Don't use profile 3 · PIN changed"
              value={draft}
              disabled={update.isPending}
              onChange={(event) => setDraft(event.target.value)}
            />
            <p className="text-caption text-foreground-subtle">
              Visible to your team only. Nothing here affects availability, health or allocation.
            </p>
          </div>

          <DialogFooter>
            {/*
              Cancel simply closes. The draft is local state seeded on open, so
              nothing typed here has reached the server and discarding it cannot
              leave a partial write behind.
            */}
            <Button variant="outline" onClick={() => setOpen(false)} disabled={update.isPending}>
              Cancel
            </Button>
            <Button onClick={save} loading={update.isPending} loadingLabel="Saving">
              Save note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
