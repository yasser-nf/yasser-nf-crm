"use client";

import { motion } from "framer-motion";
import { Check, Copy, MessageCircle, RotateCcw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DURATION, EASING } from "@/config/theme";
import { copyToClipboard, formatPreparedProfile } from "@/lib/clipboard";
import { formatPhoneForDisplay } from "@/lib/phone";
import { buildWhatsAppLink, buildWhatsAppMessage } from "@/lib/whatsapp";
import { Button } from "@/shared/ui/button";
import type { PreparationResult } from "../services/quick-prepare.service";

/**
 * The delivered subscription — credentials and all.
 *
 * Each profile is rendered in the exact layout M13 §6 specifies, with its own
 * copy controls. The plaintext password arrives here only because the operator
 * confirmed a transaction: it is produced by that transaction and never exists
 * in a page payload before it.
 *
 * SHARED BY QUICK PREPARE AND QUICK REPLACE.
 *
 * It began inside `quick-prepare-wizard.tsx`. Quick Replace's confirmation
 * returns the same `PreparationResult` — same accounts, same profiles, same
 * plaintext, same clipboard rules — so the alternative was a second result
 * screen formatting the same credentials slightly differently. The M13 §6 layout
 * and the copy strings are a contract with whoever pastes them into WhatsApp;
 * two implementations of a contract is one too many.
 *
 * Only the wording differs between the two flows, so only the wording is a prop.
 */
export function CredentialResult({
  result,
  title,
  restartLabel,
  onStartOver,
}: {
  result: PreparationResult;
  /** "Prepared" / "Replaced" — what just happened. */
  title: string;
  /** The label on the start-again action. */
  restartLabel: string;
  onStartOver: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  /*
   * Derived from the confirmed result on every render, never held in state.
   * State would be one more place for a previous preparation to survive into
   * the next one; this cannot outlive the `result` it was computed from.
   */
  const messageInput = {
    identifier: result.customerPhone,
    accounts: result.accounts.map((account) => ({
      email: account.email,
      password: account.password,
      profiles: account.profiles.map((profile) => ({
        profileNumber: profile.profileNumber,
        pin: profile.pin,
      })),
    })),
    durationDays: result.durationDays,
    expirationDate: result.expirationDate,
  };

  const whatsapp = buildWhatsAppLink(messageInput);
  /* The same text the link would have carried, for the cases that have no link. */
  const fallbackMessage = buildWhatsAppMessage(messageInput);

  async function write(text: string, key: string, label: string) {
    const success = await copyToClipboard(text);

    if (!success) {
      toast.error("Could not copy", { description: "Your browser blocked clipboard access." });
      return;
    }

    setCopied(key);
    toast.success(label);
    setTimeout(() => setCopied((current) => (current === key ? null : current)), 2000);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASING.out }}
      className="flex flex-col gap-5"
    >
      <div className="flex items-start gap-3 rounded-md border border-success/30 bg-success-subtle p-4">
        <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="text-card-title text-foreground">{title}</p>
          <p className="text-caption text-foreground-muted">
            {formatPhoneForDisplay(result.customerPhone)} · {result.durationDays} days · expires{" "}
            {new Date(result.expirationDate).toLocaleDateString(undefined, { dateStyle: "medium" })}
          </p>
        </div>
      </div>

      {result.requiresPasswordChange ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-warning/40 bg-warning-subtle p-4"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <p className="text-caption text-foreground-muted">
            <span className="text-foreground">Password change confirmed.</span> Make sure the new
            password below is the one you set, and that the profile was updated, before sending
            these credentials.
          </p>
        </div>
      ) : null}

      {result.accounts.map((account) =>
        account.profiles.map((profile) => (
          <section
            key={profile.profileId}
            className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-section-title text-foreground">
                Profile {profile.profileNumber}
                {profile.profileName ? ` · ${profile.profileName}` : ""}
              </h2>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    write(
                      formatPreparedProfile({
                        email: account.email,
                        password: account.password,
                        profileNumber: profile.profileNumber,
                        pin: profile.pin,
                      }),
                      `all-${profile.profileId}`,
                      "Copied everything",
                    )
                  }
                  className="gap-2"
                >
                  {copied === `all-${profile.profileId}` ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Copy className="size-3.5" aria-hidden="true" />
                  )}
                  Copy all
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    write(
                      `${account.email} ${account.password}`,
                      `creds-${profile.profileId}`,
                      "Copied credentials",
                    )
                  }
                  className="gap-2"
                >
                  {copied === `creds-${profile.profileId}` ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Copy className="size-3.5" aria-hidden="true" />
                  )}
                  Copy credentials
                </Button>
              </div>
            </div>

            {/* The exact layout M13 §6 specifies. */}
            <dl className="flex flex-col gap-3">
              <CredentialRow label="Email" value={account.email} />
              <CredentialRow label="Password" value={account.password} mono />
              <CredentialRow label="Profile number" value={String(profile.profileNumber)} />
              <CredentialRow label="Code pin" value={profile.pin ?? "—"} mono />
            </dl>
          </section>
        )),
      )}

      {/*
        Composed here, from `result`, and nowhere earlier.

        `result` is what the confirmed transaction returned, so the link can only
        describe the account the customer actually received. Quick Replace gets
        the new one for free: the replaced account is not in the result it
        renders, so there is nothing stale to pick up by mistake.

        The URL carries the password, which is why it is built in this handler
        rather than on the server — see lib/whatsapp.
      */}
      {whatsapp.available ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button variant="outline" asChild className="h-11 gap-2">
              <a href={whatsapp.url} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="size-4" aria-hidden="true" />
                Open WhatsApp
              </a>
            </Button>

            <Button
              variant="outline"
              onClick={() => write(whatsapp.message, "message", "Copied the message")}
              className="h-11 gap-2"
            >
              {copied === "message" ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
              Copy message
            </Button>
          </div>

          <Button variant="ghost" onClick={onStartOver} className="h-11 gap-2">
            <RotateCcw className="size-4" aria-hidden="true" />
            {restartLabel}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/*
            No button at all rather than one that cannot work. A username is a
            legitimate identifier here, so this explains rather than complains —
            and the credentials above stay copyable, which is the whole point.
          */}
          <div className="flex items-start gap-3 rounded-md border border-border bg-surface p-4">
            <MessageCircle
              className="mt-0.5 size-4 shrink-0 text-foreground-subtle"
              aria-hidden="true"
            />
            <div className="flex flex-col gap-1">
              <p className="text-card-title text-foreground">WhatsApp unavailable</p>
              <p className="text-caption text-foreground-muted">
                {whatsapp.reason === "username"
                  ? "This customer is saved under a username, which WhatsApp cannot be opened for. Copy the message and send it however you reach them."
                  : "This customer's phone number cannot be used for WhatsApp. Copy the message and send it another way."}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
            <Button
              variant="outline"
              onClick={() => write(fallbackMessage, "message", "Copied the message")}
              className="h-11 gap-2"
            >
              {copied === "message" ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
              Copy message
            </Button>

            <Button variant="ghost" onClick={onStartOver} className="h-11 gap-2">
              <RotateCcw className="size-4" aria-hidden="true" />
              {restartLabel}
            </Button>
          </div>
        </div>
      )}
    </motion.div>
  );
}

function CredentialRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-foreground-subtle">{label}</dt>
      <dd
        className={`rounded-md bg-background-secondary px-3 py-2 text-description text-foreground ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
