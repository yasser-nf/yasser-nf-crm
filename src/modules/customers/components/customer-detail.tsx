"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { motion } from "framer-motion";
import {
  Ban,
  CircleDot,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Repeat,
  ShieldOff,
  Tag,
  TimerOff,
  UserRoundCheck,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ROUTES } from "@/config/constants";
import { DURATION, EASING } from "@/config/theme";
import { formatAccountCredentials } from "@/lib/clipboard";
import type { ProfileEventRow } from "@/lib/drizzle/schema";
import { ActionError } from "@/lib/errors";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import type { CustomerDetail, CustomerSubscription } from "../services/customers.service";
import { CopyButton, CustomerStatusBadge, ExpiryBadge, WhatsappButton } from "./customer-shared";
import { useArchiveCustomer, useSetBlocked, useUpdateNotes } from "../hooks/use-customer-mutations";

/**
 * Customer detail.
 *
 * The credential copy is the reason this screen exists for a worker: it turns
 * "which account is this customer on" into one click.
 */

function formatDate(value: string | Date | null): string {
  return value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
}

export function CustomerDetailView({
  detail,
  canAdminister,
}: {
  detail: CustomerDetail;
  canAdminister: boolean;
}) {
  const { customer, status, displayPhone, activeSubscriptions, expiredSubscriptions } = detail;

  /**
   * The whole active allocation, formatted once.
   *
   * Expired allocations are excluded deliberately — M05 forbids exposing
   * credentials for them, and an expired profile's PIN may already belong to
   * someone else.
   */
  const credentialBlock = activeSubscriptions
    .map((subscription) =>
      formatAccountCredentials({
        email: subscription.accountEmail,
        /* Filled server-side only when explicitly requested; never in this payload. */
        password: "—",
        profiles: [
          {
            profileNumber: subscription.profileNumber,
            pin: subscription.pin,
            profileName: subscription.profileName,
          },
        ],
      }),
    )
    .join("\n\n———\n\n");

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={ROUTES.CUSTOMERS}
        className="inline-flex w-fit items-center gap-1.5 text-caption text-foreground-muted hover:text-foreground"
      >
        ← All customers
      </Link>

      <section className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-mono text-page-title text-foreground">{displayPhone}</h1>
              <CustomerStatusBadge status={status} />
            </div>
            <p className="text-caption text-foreground-subtle">
              Created {formatDate(customer.createdAt)} · Last purchase{" "}
              {formatDate(customer.lastPurchaseAt)}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <WhatsappButton url={customer.whatsappUrl} />
            <CopyButton value={customer.phoneNormalized} label="Copy phone" />
            <CopyButton value={customer.whatsappUrl} label="Copy link" />
            {activeSubscriptions.length > 0 ? (
              <CopyButton value={credentialBlock} label="Copy credentials" />
            ) : null}
            {canAdminister ? <AdminActions detail={detail} /> : null}
          </div>
        </div>

        {status === "blocked" ? (
          <p className="flex items-start gap-2 rounded-md bg-danger-subtle p-3 text-caption text-danger">
            <ShieldOff className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            This customer is blocked. They should not be given new subscriptions.
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-section-title text-foreground">
          Current subscriptions ({activeSubscriptions.length})
        </h2>

        {activeSubscriptions.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-description text-foreground-muted">
            No active subscriptions.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {activeSubscriptions.map((subscription, index) => (
              <SubscriptionCard
                key={subscription.profileId}
                subscription={subscription}
                index={index}
              />
            ))}
          </div>
        )}
      </section>

      {expiredSubscriptions.length > 0 ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-section-title text-foreground">
            Expired ({expiredSubscriptions.length})
          </h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {expiredSubscriptions.map((subscription, index) => (
              <SubscriptionCard
                key={subscription.profileId}
                subscription={subscription}
                index={index}
                muted
              />
            ))}
          </div>
        </section>
      ) : null}

      <NotesEditor customerId={customer.id} notes={customer.notes ?? ""} />

      <ReplacementHistory events={detail.timeline} />

      <section className="flex flex-col gap-4">
        <h2 className="text-section-title text-foreground">Purchase timeline</h2>
        <CustomerTimeline events={detail.timeline} />
      </section>
    </div>
  );
}

function SubscriptionCard({
  subscription,
  index,
  muted = false,
}: {
  subscription: CustomerSubscription;
  index: number;
  muted?: boolean;
}) {
  const accountUnhealthy = subscription.accountStatus !== "healthy";

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASING.out, delay: Math.min(index * 0.04, 0.2) }}
      className={`flex flex-col gap-3 rounded-lg border border-border bg-surface p-5 ${muted ? "opacity-70" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-card-title text-foreground">
            {subscription.accountEmail}
          </span>
          <span className="text-caption text-foreground-subtle">
            Profile {subscription.profileNumber}
            {subscription.profileName ? ` · ${subscription.profileName}` : ""}
          </span>
        </div>
        <ExpiryBadge urgency={subscription.urgency} remainingDays={subscription.remainingDays} />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-caption">
        <div className="flex flex-col">
          <dt className="text-foreground-subtle">PIN</dt>
          <dd className="font-mono text-foreground">{subscription.pin ?? "—"}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-foreground-subtle">Account health</dt>
          <dd
            className={
              subscription.accountHealthScore >= 80
                ? "text-success"
                : subscription.accountHealthScore >= 50
                  ? "text-warning"
                  : "text-danger"
            }
          >
            {subscription.accountHealthScore}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-foreground-subtle">Started</dt>
          <dd className="text-foreground">{formatDate(subscription.saleDate)}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-foreground-subtle">Expires</dt>
          <dd className="text-foreground">{formatDate(subscription.expirationDate)}</dd>
        </div>
      </dl>

      {accountUnhealthy ? (
        <p className="flex items-start gap-2 rounded-md bg-warning-subtle p-2.5 text-caption text-warning">
          <Ban className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          The account has a problem. This customer may need a replacement.
        </p>
      ) : null}

      <Button variant="outline" size="sm" asChild className="mt-auto gap-2 self-start">
        <Link href={`${ROUTES.ACCOUNTS}/${subscription.accountId}`}>
          <ExternalLink className="size-3.5" aria-hidden="true" />
          Open account
        </Link>
      </Button>
    </motion.article>
  );
}

const NOTES_SCHEMA = z.object({ notes: z.string().trim().max(2000) });

function NotesEditor({ customerId, notes }: { customerId: string; notes: string }) {
  const update = useUpdateNotes(customerId);

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm<z.infer<typeof NOTES_SCHEMA>>({
    resolver: zodResolver(NOTES_SCHEMA),
    defaultValues: { notes },
  });

  const serverError =
    update.error instanceof ActionError ? update.error.fieldErrors?.["notes"] : undefined;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-6">
      <Label htmlFor="customer-notes" className="text-section-title text-foreground">
        Internal notes
      </Label>

      <form
        onSubmit={handleSubmit((values) => update.mutate(values.notes))}
        className="flex flex-col gap-3"
      >
        <Textarea
          id="customer-notes"
          rows={4}
          placeholder="Anything worth remembering about this customer"
          disabled={update.isPending}
          className="bg-background-secondary"
          {...register("notes")}
        />

        {(errors.notes?.message ?? serverError) ? (
          <p role="alert" className="text-caption text-danger">
            {errors.notes?.message ?? serverError}
          </p>
        ) : null}

        <Button
          type="submit"
          disabled={update.isPending || !isDirty}
          className="min-w-32 gap-2 self-start"
        >
          {update.isPending ? (
            <>
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Saving
            </>
          ) : (
            "Save notes"
          )}
        </Button>
      </form>
    </section>
  );
}

function AdminActions({ detail }: { detail: CustomerDetail }) {
  const router = useRouter();
  const blocked = detail.customer.blockedAt !== null;
  const setBlocked = useSetBlocked(detail.customer.id);
  const archive = useArchiveCustomer(detail.customer.id);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={setBlocked.isPending}
        onClick={() => setBlocked.mutate(!blocked)}
        className="gap-2"
      >
        <ShieldOff className="size-3.5" aria-hidden="true" />
        {blocked ? "Unblock" : "Block"}
      </Button>

      <Button
        variant="ghost"
        size="sm"
        disabled={archive.isPending}
        onClick={() => {
          archive.mutate(undefined, {
            onSuccess: () => {
              toast.success("Customer archived");
              router.push(ROUTES.CUSTOMERS);
            },
          });
        }}
        className="gap-2 text-danger hover:bg-danger-subtle hover:text-danger"
      >
        Archive
      </Button>
    </>
  );
}

const EVENT_PRESENTATION: Record<
  ProfileEventRow["eventType"],
  { icon: LucideIcon; label: string; tone: string }
> = {
  created: { icon: CircleDot, label: "Profile created", tone: "text-foreground-muted" },
  sold: { icon: Tag, label: "Subscription purchased", tone: "text-accent-purple" },
  replaced: { icon: Repeat, label: "Replaced", tone: "text-info" },
  extended: { icon: RefreshCw, label: "Renewed", tone: "text-success" },
  expired: { icon: TimerOff, label: "Expired", tone: "text-danger" },
  pin_changed: { icon: KeyRound, label: "PIN changed", tone: "text-foreground-muted" },
  name_changed: { icon: Tag, label: "Profile renamed", tone: "text-foreground-muted" },
  customer_changed: { icon: UserRoundCheck, label: "Customer changed", tone: "text-info" },
  status_changed: { icon: CircleDot, label: "Status changed", tone: "text-warning" },
};

/**
 * Purchase timeline.
 *
 * ADR-006 Decision 1: profile_events is the only event source. This is the same
 * table the account timeline reads, filtered by customer instead of account —
 * one history, two views, no duplication.
 */
export function CustomerTimeline({ events }: { events: readonly ProfileEventRow[] }) {
  if (events.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-description text-foreground-muted">
        No history yet.
      </p>
    );
  }

  return (
    <ol className="flex flex-col">
      {events.map((event, index) => {
        const presentation = EVENT_PRESENTATION[event.eventType];
        const Icon = presentation.icon;
        const isLast = index === events.length - 1;

        return (
          <li key={event.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface">
                <Icon className={`size-3.5 ${presentation.tone}`} aria-hidden="true" />
              </span>
              {!isLast ? <span className="w-px flex-1 bg-border" aria-hidden="true" /> : null}
            </div>

            <div className={`flex min-w-0 flex-col gap-0.5 ${isLast ? "" : "pb-5"}`}>
              <span className="text-description text-foreground">{presentation.label}</span>
              <span className="text-caption text-foreground-subtle">
                {new Date(event.createdAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
              {event.notes ? (
                <span className="text-caption text-foreground-muted">{event.notes}</span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Replacement history.
 *
 * Reconstructed from `replaced` events rather than stored separately. Each swap
 * writes two events — a cancellation on the old account and a reallocation on
 * the new one — and `metadata.outcome` distinguishes them.
 */
function ReplacementHistory({ events }: { events: readonly ProfileEventRow[] }) {
  const replacements = events.filter((event) => event.eventType === "replaced");

  if (replacements.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-section-title text-foreground">Replacement history</h2>

      <ul className="flex flex-col gap-2">
        {replacements.map((event) => {
          const metadata = (event.metadata ?? {}) as Record<string, unknown>;
          const outcome = String(metadata["outcome"] ?? "");
          const reason = String(metadata["reason"] ?? "account problem");

          return (
            <li
              key={event.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-secondary px-4 py-3 text-caption"
            >
              <span className="text-foreground">
                {outcome === "cancelled" ? "Released from account" : "Moved to new account"}
                {" · "}
                <span className="text-foreground-muted">{reason.replace(/_/g, " ")}</span>
              </span>
              <span className="text-foreground-subtle">
                {new Date(event.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
