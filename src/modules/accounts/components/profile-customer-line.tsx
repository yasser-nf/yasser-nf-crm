"use client";

import { Check, Copy, MessageCircle, User, UserX } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { copyToClipboard } from "@/lib/clipboard";
import { Button } from "@/shared/ui/button";
import { cn } from "@/utils/cn";
import {
  PROFILE_CUSTOMER_EMPTY_LABEL,
  PROFILE_CUSTOMER_MISSING_LABEL,
  type ProfileCustomerLink,
} from "../services/profile-customer";

/**
 * The Customer line on a profile card.
 *
 * One component for every screen that draws one, because the requirement is
 * that this field is NEVER visually blank — and three screens each writing
 * their own `customer ? … : ""` is exactly how one of them ends up empty. It
 * was that shape, `customerLabel={profile.customerId ? "Assigned" : null}`,
 * that hid every customer on the account detail page.
 *
 * The three cases are visually distinct rather than three shades of the same
 * grey: a named customer reads as content, an unheld slot reads as a neutral
 * absence, and a broken link reads as a fault, because it is one.
 */
export function ProfileCustomerLine({
  customer,
  variant = "row",
  className,
}: {
  readonly customer: ProfileCustomerLink;
  /**
   * `row` puts the label and value on one line, for the dense inline panel.
   * `stacked` puts the value under the label, for the detail page's card grid.
   * The wording and the states are identical either way — only the box differs.
   */
  readonly variant?: "row" | "stacked";
  readonly className?: string;
}) {
  const stacked = variant === "stacked";

  return (
    <div
      className={cn(
        stacked ? "flex flex-col gap-0.5" : "flex items-baseline justify-between gap-2",
        className,
      )}
    >
      <dt className="shrink-0 text-foreground-subtle">Customer</dt>
      <dd className={cn("min-w-0", stacked ? "text-left" : "text-right")}>
        <ProfileCustomerValue customer={customer} stacked={stacked} />
      </dd>
    </div>
  );
}

function ProfileCustomerValue({
  customer,
  stacked,
}: {
  readonly customer: ProfileCustomerLink;
  readonly stacked: boolean;
}) {
  const line = cn("flex min-w-0 items-center gap-1.5", stacked ? "justify-start" : "justify-end");

  if (customer.kind === "linked") {
    const { label, whatsappUrl, isArchived } = customer.customer;

    return (
      <span className={cn(line, "flex-wrap")}>
        <User className="size-3 shrink-0 text-foreground-subtle" aria-hidden="true" />
        {/*
          Monospace, like every other phone number in the app: it keeps the digit
          groups aligned down a column of five cards.
        */}
        <span className="truncate font-mono text-foreground">{label}</span>
        {isArchived ? (
          /*
           * The customer record was archived, but they still hold this slot.
           * Said out loud rather than hidden — otherwise the sale looks
           * anonymous and nobody knows why.
           */
          <span className="shrink-0 text-foreground-subtle">(archived)</span>
        ) : null}

        {/*
          Both actions live inside the Customer line rather than in the card's
          footer, so it is unambiguous WHOSE number they act on when five cards
          sit side by side.
        */}
        <span
          className="flex shrink-0 items-center gap-0.5"
          /*
           * Stops a click reaching the card. Neither action may open the Edit
           * Profile dialog — they are meant to be the fast path that avoids it.
           */
          onClick={(event) => event.stopPropagation()}
        >
          <CopyCustomerButton label={label} />
          <WhatsappCustomerButton url={whatsappUrl} label={label} />
        </span>
      </span>
    );
  }

  if (customer.kind === "unavailable") {
    return (
      <span className={cn(line, "text-danger")}>
        <UserX className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{PROFILE_CUSTOMER_MISSING_LABEL}</span>
      </span>
    );
  }

  /* Never an empty cell. An unheld slot says so in words. */
  return <span className="text-foreground-subtle">— {PROFILE_CUSTOMER_EMPTY_LABEL}</span>;
}

/**
 * Copies the customer's identifier, with no dialog in the way.
 *
 * The same shape as the account credential controls: `copyToClipboard`, a
 * toast, and the icon held on a tick for two seconds. Copying the DISPLAYED
 * label rather than the stored key, so what lands in the clipboard is what the
 * operator just read on screen.
 */
function CopyCustomerButton({ label }: { readonly label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const success = await copyToClipboard(label);

    if (!success) {
      toast.error("Could not copy", { description: "Your browser blocked clipboard access." });
      return;
    }

    setCopied(true);
    toast.success("Customer copied");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => void copy()}
      title={`Copy ${label}`}
      aria-label={`Copy customer ${label}`}
      /*
       * 44px of touch target on a phone, shrinking to a dense icon button once
       * there is a mouse. `size-11` with `-my-2` keeps the tall tap area from
       * stretching the card's line height.
       */
      className={cn("size-11 shrink-0 px-0 sm:size-7", "-my-2 sm:my-0", copied && "text-success")}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </Button>
  );
}

/**
 * Opens a WhatsApp chat with this customer.
 *
 * No prefilled message: this is "reach this person", not the credential handover
 * Quick Prepare performs. The URL was built by `whatsappDestination`, the
 * function that also builds Quick Prepare's, so a number that works in one works
 * in the other.
 *
 * A null URL is a real state — a username, or a number wa.me cannot address —
 * and it renders as disabled text rather than a link that opens on nothing.
 */
function WhatsappCustomerButton({
  url,
  label,
}: {
  readonly url: string | null;
  readonly label: string;
}) {
  if (url === null) {
    return (
      <span
        className="shrink-0 px-1 text-caption text-foreground-subtle"
        title="This identifier cannot be opened in WhatsApp"
      >
        WhatsApp unavailable
      </span>
    );
  }

  return (
    <Button
      asChild
      variant="ghost"
      size="sm"
      title={`Open WhatsApp with ${label}`}
      className="-my-2 size-11 shrink-0 px-0 text-success sm:my-0 sm:size-7"
    >
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open WhatsApp with ${label}`}
      >
        <MessageCircle className="size-3.5" aria-hidden="true" />
      </a>
    </Button>
  );
}
