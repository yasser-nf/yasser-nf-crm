"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { AlertTriangle, Bell, CheckCheck } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ActionError } from "@/lib/errors";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Skeleton } from "@/shared/ui/skeleton";
import { cn } from "@/utils/cn";
import {
  getNotificationsAction,
  markAllNotificationsReadAction,
  markNotificationReadAction,
  type ActionResult,
} from "../actions/notification.actions";
import {
  RECENT_NOTIFICATIONS_LIMIT,
  type NotificationItem,
  type NotificationSummary,
} from "../services/notification-types";

/**
 * The bell in the top bar (M05).
 *
 * WHEN IT ASKS. On mount, when the panel opens, and after navigating — the last
 * only if what it holds is older than the query cache's 30 seconds. There is no
 * timer: nothing in this application polls, and the brief forbids starting.
 * A notification created while someone sits still on one page appears the next
 * time they move or open the panel.
 *
 * WHAT IT NEVER SAYS. A count that could not be read is not zero: the bell
 * shows a warning mark instead of a number, and the panel says the list could
 * not be loaded rather than "no notifications".
 */

export const NOTIFICATIONS_QUERY_KEY = ["notifications"] as const;

function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code);
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function relativeTime(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;

  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** What the badge shows. `null` means "nothing to show", never "unknown". */
export function unreadBadge(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

export function NotificationCenter() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const summary = useQuery({
    queryKey: NOTIFICATIONS_QUERY_KEY,
    queryFn: async () => unwrap(await getNotificationsAction()),
  });

  /*
   * Refresh on navigation, but only a stale answer, and not on the first render
   * (the query is already fetching then). This is revalidation, not polling.
   */
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }

    void queryClient.refetchQueries(
      { queryKey: NOTIFICATIONS_QUERY_KEY, stale: true },
      /* Never duplicates a request already in flight. */
      { cancelRefetch: false },
    );
  }, [pathname, queryClient]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });

  const markRead = useMutation({
    mutationFn: async (id: string) => unwrap(await markNotificationReadAction(id)),
    onSettled: invalidate,
    onError: (error) =>
      toast.error(error instanceof ActionError ? error.userMessage : "Could not mark as read."),
  });

  const markAll = useMutation({
    mutationFn: async () => unwrap(await markAllNotificationsReadAction()),
    onSettled: invalidate,
    onError: (error) =>
      toast.error(
        error instanceof ActionError ? error.userMessage : "Could not mark notifications as read.",
      ),
  });

  function onOpenChange(next: boolean) {
    setOpen(next);

    /* Opening the panel always shows what is true now. */
    if (next) {
      void invalidate();
    }
  }

  function onSelect(item: NotificationItem) {
    if (!item.read) {
      markRead.mutate(item.id);
    }

    if (item.href) {
      router.push(item.href);
    }
  }

  /* A failed read — even a refresh of data already shown — is not a count. */
  const failed = summary.isError;
  const badge = !failed && summary.data ? unreadBadge(summary.data.unreadCount) : null;

  const label = failed
    ? "Notifications — could not be loaded"
    : summary.data && summary.data.unreadCount > 0
      ? `Notifications — ${summary.data.unreadCount} unread`
      : "Notifications";

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          className="relative text-foreground-muted hover:text-foreground"
        >
          <Bell aria-hidden="true" />
          {badge ? (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] leading-none font-semibold text-white"
            >
              {badge}
            </span>
          ) : null}
          {failed ? (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-warning text-white"
            >
              <AlertTriangle className="size-2.5" />
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={8}
        collisionPadding={8}
        className="flex w-[min(24rem,calc(100vw-1rem))] flex-col p-0"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <p className="text-card-title text-foreground">Notifications</p>
          <Button
            variant="ghost"
            size="sm"
            disabled={!summary.data || summary.data.unreadCount === 0 || markAll.isPending}
            onClick={() => markAll.mutate()}
            className="h-8 gap-1.5 text-caption"
          >
            <CheckCheck className="size-3.5" aria-hidden="true" />
            Mark all as read
          </Button>
        </div>

        <div className="max-h-[min(28rem,70dvh)] overflow-y-auto overscroll-contain p-1">
          <PanelBody summary={summary} onSelect={onSelect} />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PanelBody({
  summary,
  onSelect,
}: {
  summary: UseQueryResult<NotificationSummary>;
  onSelect: (item: NotificationItem) => void;
}) {
  if (summary.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading notifications" className="flex flex-col gap-3 p-3">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  if (summary.isError) {
    return (
      <div
        role="alert"
        className="m-2 flex flex-col items-center gap-3 rounded-lg border border-danger/30 bg-danger-subtle px-4 py-6 text-center"
      >
        <AlertTriangle className="size-5 text-danger" aria-hidden="true" />
        <p className="text-description text-foreground">Notifications could not be loaded.</p>
        <Button variant="outline" size="sm" onClick={() => void summary.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  if (summary.data.items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <Bell className="size-5 text-foreground-subtle" aria-hidden="true" />
        <p className="text-description text-foreground-muted">You have no notifications.</p>
      </div>
    );
  }

  const now = new Date();

  return (
    <>
      {summary.data.items.map((item) => (
        <DropdownMenuItem
          key={item.id}
          onSelect={() => onSelect(item)}
          className={cn(
            "flex min-h-12 items-start gap-2.5 rounded-md px-3 py-2",
            !item.read && "bg-primary-subtle/40",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "mt-1.5 size-2 shrink-0 rounded-full",
              item.read ? "bg-transparent" : "bg-primary",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className={cn("text-description text-foreground", !item.read && "font-semibold")}>
              {item.title}
              {!item.read ? <span className="sr-only"> (unread)</span> : null}
            </span>
            {item.body ? (
              <span className="line-clamp-2 text-caption break-words text-foreground-muted">
                {item.body}
              </span>
            ) : null}
            <time dateTime={item.createdAt} className="text-caption text-foreground-subtle">
              {relativeTime(item.createdAt, now)}
            </time>
          </span>
        </DropdownMenuItem>
      ))}
      {summary.data.items.length === RECENT_NOTIFICATIONS_LIMIT ? (
        <p className="px-3 py-2 text-center text-caption text-foreground-subtle">
          Showing the {RECENT_NOTIFICATIONS_LIMIT} most recent.
        </p>
      ) : null}
    </>
  );
}
