"use client";

import { Check, Copy, MessageCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { copyToClipboard } from "@/lib/clipboard";
import { Button } from "@/shared/ui/button";
import { cn } from "@/utils/cn";
import type { CustomerStatus, ExpiryUrgency } from "../services/customer-status";

/**
 * Shared customer presentation pieces.
 *
 * Both status maps are exhaustive by type, so adding a status without a colour
 * becomes a compile error rather than an unstyled badge.
 */

const BADGE = "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-caption font-medium";

const STATUS_STYLES: Record<CustomerStatus, { label: string; className: string; dot: string }> = {
  active: { label: "Active", className: "bg-success-subtle text-success", dot: "bg-success" },
  inactive: {
    label: "Inactive",
    className: "bg-neutral-subtle text-foreground-muted",
    dot: "bg-neutral",
  },
  blocked: { label: "Blocked", className: "bg-danger-subtle text-danger", dot: "bg-danger" },
  archived: {
    label: "Archived",
    className: "bg-neutral-subtle text-foreground-subtle",
    dot: "bg-neutral",
  },
};

export function CustomerStatusBadge({ status }: { status: CustomerStatus }) {
  const style = STATUS_STYLES[status];

  return (
    <span className={cn(BADGE, style.className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", style.dot)} aria-hidden="true" />
      {style.label}
    </span>
  );
}

const URGENCY_STYLES: Record<ExpiryUrgency, { className: string }> = {
  expired: { className: "bg-danger-subtle text-danger" },
  today: { className: "bg-danger-subtle text-danger" },
  tomorrow: { className: "bg-warning-subtle text-warning" },
  soon: { className: "bg-warning-subtle text-warning" },
  later: { className: "bg-surface-raised text-foreground-muted" },
  none: { className: "bg-surface-raised text-foreground-subtle" },
};

/**
 * Renders remaining days in the words a worker would use.
 *
 * "Expires today" carries urgency that "0 days" does not, and this badge exists
 * to be scanned quickly across a list.
 */
export function ExpiryBadge({
  urgency,
  remainingDays,
}: {
  urgency: ExpiryUrgency;
  remainingDays: number | null;
}) {
  const label =
    urgency === "none"
      ? "No expiry"
      : urgency === "expired"
        ? `Expired ${Math.abs(remainingDays ?? 0)}d ago`
        : urgency === "today"
          ? "Expires today"
          : urgency === "tomorrow"
            ? "Expires tomorrow"
            : `${remainingDays}d left`;

  return <span className={cn(BADGE, URGENCY_STYLES[urgency].className)}>{label}</span>;
}

/** Copy button that confirms in place rather than only via a toast. */
export function CopyButton({
  value,
  label,
  className,
  size = "sm",
}: {
  value: string;
  label: string;
  className?: string;
  size?: "sm" | "icon-sm";
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const success = await copyToClipboard(value);

    if (!success) {
      toast.error("Could not copy", { description: "Your browser blocked clipboard access." });
      return;
    }

    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const icon = copied ? (
    <Check className="size-3.5 text-success" aria-hidden="true" />
  ) : (
    <Copy className="size-3.5" aria-hidden="true" />
  );

  if (size === "icon-sm") {
    return (
      <Button
        variant="outline"
        size="icon-sm"
        onClick={copy}
        aria-label={copied ? "Copied" : label}
        className={className}
      >
        {icon}
      </Button>
    );
  }

  return (
    <Button variant="outline" size="sm" onClick={copy} className={cn("gap-2", className)}>
      {icon}
      {copied ? "Copied" : label}
    </Button>
  );
}

/**
 * Opens WhatsApp for this customer.
 *
 * `noopener` matters on a target=_blank link: without it the opened page can
 * reach back through window.opener.
 */
export function WhatsappButton({
  url,
  variant = "outline",
  className,
}: {
  url: string;
  variant?: "outline" | "ghost";
  className?: string;
}) {
  return (
    <Button variant={variant} size="sm" asChild className={cn("gap-2", className)}>
      <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open WhatsApp">
        <MessageCircle className="size-3.5" aria-hidden="true" />
        WhatsApp
      </a>
    </Button>
  );
}
