import {
  CircleDot,
  Clock,
  KeyRound,
  RefreshCw,
  Repeat,
  Tag,
  TimerOff,
  UserRoundCheck,
  type LucideIcon,
} from "lucide-react";

import type { ProfileEventRow } from "@/lib/drizzle/schema";

/**
 * Account timeline.
 *
 * ADR-006 Decision 1: profile_events is the only event source, and account
 * history is that table queried by account_id. This is the screen that decision
 * was made for.
 *
 * A Server Component — it renders data and holds no interaction, so there is no
 * reason to ship it to the browser.
 */

const EVENT_PRESENTATION: Record<
  ProfileEventRow["eventType"],
  { icon: LucideIcon; label: string; tone: string }
> = {
  created: { icon: CircleDot, label: "Profile created", tone: "text-foreground-muted" },
  sold: { icon: Tag, label: "Sold", tone: "text-accent-purple" },
  replaced: { icon: Repeat, label: "Replaced", tone: "text-info" },
  extended: { icon: RefreshCw, label: "Extended", tone: "text-success" },
  expired: { icon: TimerOff, label: "Expired", tone: "text-danger" },
  pin_changed: { icon: KeyRound, label: "PIN changed", tone: "text-foreground-muted" },
  name_changed: { icon: Tag, label: "Name changed", tone: "text-foreground-muted" },
  customer_changed: { icon: UserRoundCheck, label: "Customer changed", tone: "text-info" },
  status_changed: { icon: CircleDot, label: "Status changed", tone: "text-warning" },
};

function formatDateTime(value: Date | string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function AccountTimeline({ events }: { events: readonly ProfileEventRow[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
        <Clock className="mx-auto size-5 text-foreground-subtle" aria-hidden="true" />
        <p className="mt-3 text-description text-foreground-muted">
          Nothing has happened to this account&apos;s profiles yet.
        </p>
      </div>
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
            {/* Rail: icon plus the connector to the next entry. */}
            <div className="flex flex-col items-center">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface">
                <Icon className={`size-3.5 ${presentation.tone}`} aria-hidden="true" />
              </span>
              {!isLast ? <span className="w-px flex-1 bg-border" aria-hidden="true" /> : null}
            </div>

            <div className={`flex min-w-0 flex-col gap-0.5 ${isLast ? "pb-0" : "pb-5"}`}>
              <span className="text-description text-foreground">{presentation.label}</span>
              <span className="text-caption text-foreground-subtle">
                {formatDateTime(event.createdAt)}
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
