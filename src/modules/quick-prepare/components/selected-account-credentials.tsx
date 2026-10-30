"use client";

import { Check, Copy, Eye, EyeOff, KeyRound, LoaderCircle, Mail } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { copyToClipboard, formatCredentialPair } from "@/lib/clipboard";
import { Button } from "@/shared/ui/button";
import { cn } from "@/utils/cn";
import type { ActionResult } from "../actions/quick-prepare.actions";
import type { SelectedCredentials } from "../services/selected-credentials.service";

/**
 * "Account credentials" for the account about to be sold or handed over (M09D).
 *
 * WHERE THE PASSWORD COMES FROM, AND WHEN
 *
 * The email arrives as a prop — it is already on screen in the suggestion. The
 * password never does. It is fetched only when the operator clicks Show, Copy
 * password or Copy both, through `reveal`, which asks the server to re-check
 * that this account is still the current selection before it decrypts
 * anything. Nothing is fetched on mount, and nothing is copied on its own.
 *
 * HOW LONG IT LIVES
 *
 * In this component's state, for as long as this selection is on screen — so
 * Show and the copy buttons need one server round trip, not one each. The
 * parent keys this component by the selection, so choosing another account,
 * a refused confirmation, or leaving the review UNMOUNTS it, and the state —
 * the password with it — is gone. Never in storage, a URL, a log or a toast.
 *
 * A LATE ANSWER CANNOT LAND ON THE WRONG ACCOUNT
 *
 * A request still in flight when the selection changes resolves into an
 * unmounted component: `alive` is false, so the result is dropped. And the
 * server's answer must name the account this block was built for, or it is
 * discarded — the email and password shown are always one account's.
 */

/**
 * The single-line pair "Copy both" writes: email, four spaces, password.
 * Defined in `@/lib/clipboard` as `formatCredentialPair`.
 */

type CopyKind = "email" | "password" | "both";

const MASK = "••••••••••";

export function SelectedAccountCredentials({
  accountId,
  email,
  reveal,
  disabled = false,
}: {
  /** The account this block belongs to. The server's answer must match it. */
  readonly accountId: string;
  readonly email: string;
  /** Asks the server for this selection's credentials. Called on demand only. */
  readonly reveal: () => Promise<ActionResult<SelectedCredentials>>;
  /** True while a confirmation or an alternative search is in flight. */
  readonly disabled?: boolean;
}) {
  const [password, setPassword] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyKind | null>(null);

  /* False once unmounted, so a late response is dropped rather than shown. */
  const alive = useRef(true);
  /* One request at a time: a second click joins the first instead of repeating it. */
  const pending = useRef<Promise<string | null> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function obtainPassword(): Promise<string | null> {
    if (password !== null) {
      return password;
    }

    if (pending.current) {
      return pending.current;
    }

    setError(null);
    setLoading(true);

    const request = (async () => {
      try {
        const result = await reveal();

        if (!alive.current) {
          return null;
        }

        if (!result.ok) {
          setError(result.message);
          return null;
        }

        /* Belongs to another account: never shown, never copied. */
        if (result.data.accountId !== accountId || result.data.email !== email) {
          setError("These credentials no longer match the selected account. Reload the review.");
          return null;
        }

        setPassword(result.data.password);
        return result.data.password;
      } catch {
        if (alive.current) {
          setError("Could not load the credentials. Check your connection and try again.");
        }
        return null;
      } finally {
        pending.current = null;
        if (alive.current) {
          setLoading(false);
        }
      }
    })();

    pending.current = request;
    return request;
  }

  function markCopied(kind: CopyKind, label: string) {
    setCopied(kind);
    toast.success(label);
    setTimeout(() => {
      if (alive.current) {
        setCopied((current) => (current === kind ? null : current));
      }
    }, 2000);
  }

  async function write(text: string, kind: CopyKind, label: string) {
    const success = await copyToClipboard(text);

    if (!alive.current) {
      return;
    }

    if (!success) {
      toast.error("Could not copy", {
        description: "Your browser blocked clipboard access. Copy it by hand instead.",
      });
      return;
    }

    markCopied(kind, label);
  }

  async function copyPassword() {
    const value = await obtainPassword();
    if (value !== null) {
      await write(value, "password", "Password copied");
    }
  }

  async function copyBoth() {
    const value = await obtainPassword();
    if (value !== null) {
      await write(formatCredentialPair(email, value), "both", "Email and password copied");
    }
  }

  async function toggleVisible() {
    if (visible) {
      setVisible(false);
      return;
    }

    const value = await obtainPassword();
    if (value !== null && alive.current) {
      setVisible(true);
    }
  }

  const busy = disabled || loading;

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-background-secondary p-4">
      <dl className="flex min-w-0 flex-col gap-3 text-caption">
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="text-foreground-subtle">Account email</dt>
          <dd className="font-mono break-all text-foreground">{email}</dd>
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <dt className="text-foreground-subtle">Account password</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <span
              className="min-w-0 font-mono break-all text-foreground"
              /* Screen readers should not announce a row of bullets. */
              aria-label={visible && password !== null ? undefined : "Password hidden"}
            >
              {visible && password !== null ? password : MASK}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={toggleVisible}
              disabled={busy}
              aria-label={visible ? "Hide password" : "Show password"}
              title={visible ? "Hide password" : "Show password"}
              className="size-8 shrink-0 px-0"
            >
              {loading ? (
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              ) : visible ? (
                <EyeOff className="size-3.5" aria-hidden="true" />
              ) : (
                <Eye className="size-3.5" aria-hidden="true" />
              )}
            </Button>
          </dd>
        </div>
      </dl>

      {/* Wraps at 375px; three labelled buttons never fit one phone-width line. */}
      <div className="flex flex-wrap gap-2">
        <CopyButton
          label="Copy email"
          copiedLabel="Email copied"
          icon={Mail}
          active={copied === "email"}
          busy={disabled}
          onClick={() => write(email, "email", "Email copied")}
        />
        <CopyButton
          label="Copy password"
          copiedLabel="Password copied"
          icon={KeyRound}
          active={copied === "password"}
          busy={busy}
          onClick={copyPassword}
        />
        <CopyButton
          label="Copy both"
          copiedLabel="Both copied"
          icon={Copy}
          active={copied === "both"}
          busy={busy}
          onClick={copyBoth}
        />
      </div>

      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CopyButton({
  label,
  copiedLabel,
  icon: Icon,
  active,
  busy,
  onClick,
}: {
  readonly label: string;
  readonly copiedLabel: string;
  readonly icon: typeof Copy;
  readonly active: boolean;
  readonly busy: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Button
      /* Never a submit: these sit inside the confirmation's surroundings. */
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={busy}
      className={cn("h-9 gap-1.5", active && "border-success/40 text-success")}
    >
      {active ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Icon className="size-3.5" aria-hidden="true" />
      )}
      <span>{active ? copiedLabel : label}</span>
    </Button>
  );
}
