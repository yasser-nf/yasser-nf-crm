"use client";

import { Check, Copy, KeyRound, LoaderCircle, Mail } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { copyToClipboard, formatEmailAndPassword } from "@/lib/clipboard";
import { Button } from "@/shared/ui/button";
import { cn } from "@/utils/cn";
import { useRevealPassword } from "../hooks/use-account-mutations";

/**
 * Copy controls for an account's credentials.
 *
 * THE SECURITY SHAPE OF THIS COMPONENT
 *
 * It receives the email as a prop and the password never. The password is
 * fetched on click, through `revealAccountPasswordAction`, which decrypts it
 * server-side and audits the read — ADR-006 Decision 4 makes that deliberate
 * click the only path by which plaintext reaches a browser.
 *
 * That is why "Copy email" does not touch the network while the other two do.
 * The cost is a round trip the operator can feel; the benefit is that a page
 * carrying twenty-five accounts carries zero passwords, so a screenshot, a
 * cached HTML payload or a React DevTools session reveals nothing.
 *
 * The plaintext lives in a local variable for the duration of one clipboard
 * write and is never stored in component state, never logged, and never placed
 * in a URL.
 */

type CopyKind = "all" | "email" | "password";

export function CopyCredentials({
  accountId,
  email,
  /** `inline` for a table row, `full` for the detail page header. */
  variant = "inline",
  className,
}: {
  accountId: string;
  email: string;
  variant?: "inline" | "full";
  className?: string;
}) {
  const [copied, setCopied] = useState<CopyKind | null>(null);
  const reveal = useRevealPassword(accountId);

  function confirm(kind: CopyKind, label: string) {
    setCopied(kind);
    toast.success(label);
    setTimeout(() => setCopied((current) => (current === kind ? null : current)), 2000);
  }

  async function write(text: string, kind: CopyKind, label: string) {
    const success = await copyToClipboard(text);

    if (!success) {
      toast.error("Could not copy", { description: "Your browser blocked clipboard access." });
      return;
    }

    confirm(kind, label);
  }

  /**
   * Fetches the plaintext, hands it to the caller, and lets it fall out of scope.
   *
   * The callback parameter is named `consume` rather than `use` because the
   * react-hooks lint rule reads a call to `use(...)` as React's `use` hook and
   * rejects it inside a try/catch. The name is load-bearing.
   */
  async function withPassword(consume: (password: string) => Promise<void>) {
    try {
      const password = await reveal.mutateAsync();
      await consume(password);
    } catch {
      /* useRevealPassword already surfaced the failure as a toast. */
    }
  }

  const isBusy = reveal.isPending;
  const compact = variant === "inline";

  return (
    <div
      /*
       * `flex-wrap` matters at 375px. The `full` variant renders three labelled
       * buttons — Copy all / Copy email / Copy password — which together exceed
       * a phone's width and pushed the account detail page into horizontal
       * scrolling. The row the account header puts this in already wraps; this
       * one has to as well, or the buttons stay on one unbreakable line.
       */
      className={cn("flex flex-wrap items-center gap-1", className)}
      /* Stops a click bubbling to a surrounding row link. */
      onClick={(event) => event.stopPropagation()}
    >
      <CopyButton
        label="Copy all"
        title="Copy email and password"
        icon={copied === "all" ? Check : Copy}
        active={copied === "all"}
        busy={isBusy}
        compact={compact}
        onClick={() =>
          withPassword(async (password) => {
            await write(formatEmailAndPassword(email, password), "all", "Credentials copied");
          })
        }
      />

      <CopyButton
        label="Copy email"
        title="Copy the email only"
        icon={copied === "email" ? Check : Mail}
        active={copied === "email"}
        busy={false}
        compact={compact}
        onClick={() => write(email, "email", "Email copied")}
      />

      <CopyButton
        label="Copy password"
        title="Copy the password only"
        icon={copied === "password" ? Check : KeyRound}
        active={copied === "password"}
        busy={isBusy}
        compact={compact}
        onClick={() =>
          withPassword(async (password) => {
            await write(password, "password", "Password copied");
          })
        }
      />
    </div>
  );
}

function CopyButton({
  label,
  title,
  icon: Icon,
  active,
  busy,
  compact,
  onClick,
}: {
  label: string;
  title: string;
  icon: typeof Copy;
  active: boolean;
  busy: boolean;
  compact: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={busy}
      title={title}
      /* The visible label collapses to an icon in a table row; the accessible name stays. */
      aria-label={label}
      className={cn("gap-1.5", active && "text-success", compact && "size-8 px-0")}
    >
      {busy ? (
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Icon className="size-3.5" aria-hidden="true" />
      )}
      {compact ? null : <span>{active ? "Copied" : label}</span>}
    </Button>
  );
}
