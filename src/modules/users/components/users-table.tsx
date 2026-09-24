"use client";

import { motion } from "framer-motion";
import { Search, UserPlus, Users as UsersIcon, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ROUTES } from "@/config/constants";
import { DURATION, EASING } from "@/config/theme";
import { EmptyState } from "@/shared/feedback/empty-state";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import { cn } from "@/utils/cn";
import type { UserListEntry } from "../services/users.service";
import {
  InvitationBadge,
  PresenceDot,
  RoleBadge,
  UserStatusBadge,
  formatDateTime,
} from "./user-shared";
import { ResendInviteButton } from "./resend-invite-button";

/**
 * Users list.
 *
 * Table on desktop, cards on mobile. Filter state lives in the URL so a view is
 * shareable and survives a refresh.
 */

interface Props {
  readonly items: readonly UserListEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export function UsersFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const current = searchParams.get("search") ?? "";
  const [value, setValue] = useState(current);
  const [synced, setSynced] = useState(current);

  if (current !== synced) {
    setSynced(current);
    setValue(current);
  }

  /* Debounced: one request per keystroke lets responses arrive out of order. */
  useEffect(() => {
    if (value === current) {
      return;
    }

    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (value.trim()) params.set("search", value.trim());
      else params.delete("search");
      params.set("offset", "0");
      router.push(`${pathname}?${params.toString()}`);
    }, 300);

    return () => clearTimeout(timer);
  }, [value, current, pathname, router, searchParams]);

  function setParam(key: string, next: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === null) params.delete(key);
    else params.set(key, next);
    params.set("offset", "0");
    router.push(`${pathname}?${params.toString()}`);
  }

  const role = searchParams.get("role");
  const status = searchParams.get("status");
  const hasFilters = current !== "" || role !== null || status !== null;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative flex-1 sm:max-w-sm">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground-subtle"
          aria-hidden="true"
        />
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Name or email"
          aria-label="Search users"
          className="h-11 pl-9"
        />
      </div>

      <Button
        variant={role === "worker" ? "default" : "outline"}
        onClick={() => setParam("role", role === "worker" ? null : "worker")}
      >
        Workers
      </Button>
      <Button
        variant={role === "super_admin" ? "default" : "outline"}
        onClick={() => setParam("role", role === "super_admin" ? null : "super_admin")}
      >
        Admins
      </Button>
      <Button
        variant={status === "active" ? "default" : "outline"}
        onClick={() => setParam("status", status === "active" ? null : "active")}
      >
        Active
      </Button>

      {hasFilters ? (
        <Button variant="ghost" onClick={() => router.push(pathname)} className="gap-1.5">
          <X className="size-4" aria-hidden="true" />
          Clear
        </Button>
      ) : null}
    </div>
  );
}

export function UsersTable({ items, total, limit, offset }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function pageHref(nextOffset: number): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("offset", String(nextOffset));
    return `${pathname}?${params.toString()}`;
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={UsersIcon}
        title="No users match"
        description="Create a user to give a colleague access to the CRM."
      />
    );
  }

  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(Math.ceil(total / limit), 1);

  return (
    <div className="flex flex-col gap-4">
      <div className="hidden overflow-x-auto rounded-lg border border-border lg:block">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-surface">
            <TableRow className="hover:bg-transparent">
              {[
                "Name",
                "Email",
                "Role",
                "Status",
                "Invitation",
                "Presence",
                "Last login",
                "Created",
                "",
              ].map((label) => (
                <TableHead key={label} className="text-caption text-foreground-muted">
                  {/* The Actions column is deliberately unlabelled — the row's
                        controls speak for themselves and a header would widen
                        the table for nothing. */}
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>

          <TableBody>
            {items.map((entry, index) => (
              <motion.tr
                key={entry.user.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{
                  duration: DURATION.fast,
                  ease: EASING.standard,
                  delay: Math.min(index * 0.015, 0.15),
                }}
                className="border-b border-border transition-colors last:border-0 hover:bg-surface-raised"
              >
                <TableCell className="font-medium">
                  <Link
                    href={`${ROUTES.USERS}/${entry.user.id}`}
                    className="text-foreground hover:text-primary"
                  >
                    {entry.user.name}
                  </Link>
                </TableCell>
                <TableCell className="text-foreground-muted">{entry.user.email}</TableCell>
                <TableCell>
                  <RoleBadge role={entry.user.role} />
                </TableCell>
                <TableCell>
                  <UserStatusBadge
                    status={entry.user.status}
                    archived={entry.user.deletedAt !== null}
                  />
                </TableCell>
                <TableCell>
                  {/*
                    A second badge rather than a fourth value in the status one:
                    somebody can be Active AND not have accepted their invitation,
                    and that pair is exactly who the Resend action is for.
                  */}
                  <InvitationBadge state={entry.invitation} />
                </TableCell>
                <TableCell>
                  <PresenceDot presence={entry.presence} />
                </TableCell>
                <TableCell className="text-caption text-foreground-muted">
                  {formatDateTime(entry.user.lastLoginAt)}
                </TableCell>
                <TableCell className="text-caption text-foreground-muted">
                  {formatDateTime(entry.user.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  {/* Far right, and present only where there is something to resend. */}
                  {entry.invitation !== "accepted" ? (
                    <ResendInviteButton userId={entry.user.id} email={entry.user.email} />
                  ) : null}
                </TableCell>
              </motion.tr>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile — cards, per 04_UI_GUIDELINES.md */}
      <div className="flex flex-col gap-3 lg:hidden">
        {items.map((entry) => (
          /*
           * The card was a single <Link> wrapping everything. It cannot stay
           * one: a <button> inside an <a> is invalid HTML, and tapping Resend
           * would navigate to the user instead of opening the confirmation.
           *
           * So the link now covers the part that is a link — the person — and
           * the action sits beside it as a sibling. Tapping the card still opens
           * the user, which is the behaviour that had to survive.
           */
          <div
            key={entry.user.id}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
          >
            <Link href={`${ROUTES.USERS}/${entry.user.id}`} className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-card-title text-foreground">
                    {entry.user.name}
                  </span>
                  <span className="truncate text-caption text-foreground-subtle">
                    {entry.user.email}
                  </span>
                </div>
                <PresenceDot presence={entry.presence} />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <RoleBadge role={entry.user.role} />
                <UserStatusBadge
                  status={entry.user.status}
                  archived={entry.user.deletedAt !== null}
                />
                <InvitationBadge state={entry.invitation} />
              </div>
            </Link>

            {entry.invitation !== "accepted" ? (
              /* Full width so it cannot overflow a narrow card. */
              <ResendInviteButton
                userId={entry.user.id}
                email={entry.user.email}
                className="h-11 w-full justify-center gap-1.5 border border-border text-foreground-muted"
              />
            ) : null}
          </div>
        ))}
      </div>

      <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
        <p className="text-caption text-foreground-subtle">
          {total} user{total === 1 ? "" : "s"} · page {page} of {pageCount}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => router.push(pageHref(Math.max(offset - limit, 0)))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + limit >= total}
            onClick={() => router.push(pageHref(offset + limit))}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Who is working right now.
 *
 * Rendered from the same derived presence as the table, not a second source. It
 * is deliberately quiet when nobody is around — an empty strip that still takes
 * up space would train people to ignore it.
 */
export function OnlineNow({ entries }: { entries: readonly UserListEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="flex items-center gap-2 text-caption text-foreground-subtle">
        <span className="size-1.5 shrink-0 rounded-full bg-neutral" aria-hidden="true" />
        Nobody is active right now.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-caption text-foreground-muted">Active now ({entries.length})</span>
      {entries.map((entry) => (
        <Link
          key={entry.user.id}
          href={`${ROUTES.USERS}/${entry.user.id}`}
          className="flex items-center gap-2 rounded-full border border-border bg-surface py-1 pr-3 pl-2 text-caption text-foreground transition-colors hover:bg-surface-raised"
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              entry.presence === "online" ? "bg-success" : "bg-warning",
            )}
            aria-hidden="true"
          />
          {entry.user.name}
        </Link>
      ))}
    </div>
  );
}

export function CreateUserButton() {
  return (
    <Button asChild className="gap-2">
      <Link href={`${ROUTES.USERS}/new`}>
        <UserPlus className="size-4" aria-hidden="true" />
        Create User
      </Link>
    </Button>
  );
}
