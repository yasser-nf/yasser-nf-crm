"use client";

import { useMutation } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Activity,
  KeyRound,
  LogIn,
  LogOut,
  Monitor,
  ShieldAlert,
  ShieldOff,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ROUTES } from "@/config/constants";
import { DURATION, EASING } from "@/config/theme";
import { ActionError } from "@/lib/errors";
import { Button } from "@/shared/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import {
  archiveUserAction,
  changeUserRoleAction,
  changeUserStatusAction,
  revokeAllSessionsAction,
  revokeSessionAction,
  type ActionResult,
} from "../actions/user.actions";
import type { UserDetail } from "../services/users.service";
import {
  PresenceDot,
  RoleBadge,
  UserStatusBadge,
  describeDevice,
  formatDateTime,
} from "./user-shared";

/**
 * User detail.
 *
 * Every control here is a convenience. The service refuses the same operations
 * independently, so removing a button changes what is easy, not what is
 * permitted.
 */

function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw new ActionError(result.message, result.code, result.fieldErrors);
}

export function UserDetailView({ detail, isSelf }: { detail: UserDetail; isSelf: boolean }) {
  const router = useRouter();
  const { user, sessions, activity, loginHistory, presence } = detail;
  const archived = user.deletedAt !== null;

  const changeRole = useMutation({
    mutationFn: async (role: string) => unwrap(await changeUserRoleAction(user.id, role)),
    onSuccess: () => {
      toast.success("Role updated");
      router.refresh();
    },
    onError: (error) => toast.error("Could not change role", { description: error.userMessage }),
  });

  const changeStatus = useMutation({
    mutationFn: async (status: string) => unwrap(await changeUserStatusAction(user.id, status)),
    onSuccess: (updated) => {
      toast.success(
        updated.status === "disabled"
          ? "User disabled and all sessions revoked"
          : `User set to ${updated.status}`,
      );
      router.refresh();
    },
    onError: (error) => toast.error("Could not change status", { description: error.userMessage }),
  });

  const revokeAll = useMutation({
    mutationFn: async () => unwrap(await revokeAllSessionsAction(user.id)),
    onSuccess: (count) => {
      toast.success(`${count} session${count === 1 ? "" : "s"} revoked`);
      router.refresh();
    },
    onError: (error) =>
      toast.error("Could not revoke sessions", { description: error.userMessage }),
  });

  const archive = useMutation({
    mutationFn: async () => unwrap(await archiveUserAction(user.id)),
    onSuccess: () => {
      toast.success("User archived");
      router.push(ROUTES.USERS);
    },
    onError: (error) => toast.error("Could not archive", { description: error.userMessage }),
  });

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={ROUTES.USERS}
        className="inline-flex w-fit items-center gap-1.5 text-caption text-foreground-muted hover:text-foreground"
      >
        ← All users
      </Link>

      <section className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-page-title text-foreground">{user.name}</h1>
              <RoleBadge role={user.role} />
              <UserStatusBadge status={user.status} archived={archived} />
              <PresenceDot presence={presence} />
            </div>
            <p className="text-caption text-foreground-subtle">
              {user.email} · Created {formatDateTime(user.createdAt)} · Last login{" "}
              {formatDateTime(user.lastLoginAt)}
            </p>
          </div>
        </div>

        {isSelf ? (
          <p className="flex items-start gap-2 rounded-md bg-background-secondary p-3 text-caption text-foreground-muted">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            This is your own account. Role and status changes are refused for yourself — a mistake
            here would lock you out with no way back through the application.
          </p>
        ) : null}

        {!archived && !isSelf ? (
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-2">
              <span className="text-caption text-foreground-subtle">Role</span>
              <Select
                value={user.role}
                onValueChange={(value) => changeRole.mutate(value)}
                disabled={changeRole.isPending}
              >
                <SelectTrigger className="h-10 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="worker">Worker</SelectItem>
                  <SelectItem value="super_admin">Super Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-caption text-foreground-subtle">Status</span>
              <Select
                value={user.status}
                onValueChange={(value) => changeStatus.mutate(value)}
                disabled={changeStatus.isPending}
              >
                <SelectTrigger className="h-10 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                  <SelectItem value="disabled">Disabled</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button
              variant="ghost"
              onClick={() => archive.mutate()}
              disabled={archive.isPending}
              className="gap-2 text-danger hover:bg-danger-subtle hover:text-danger"
            >
              <TriangleAlert className="size-4" aria-hidden="true" />
              Archive
            </Button>
          </div>
        ) : null}

        <p className="text-caption text-foreground-subtle">
          Suspended blocks sign-in but leaves sessions alone. Disabled blocks sign-in and revokes
          every session immediately.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-section-title text-foreground">
            Active sessions ({sessions.length})
          </h2>
          {sessions.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => revokeAll.mutate()}
              disabled={revokeAll.isPending}
              className="gap-2"
            >
              <ShieldOff className="size-3.5" aria-hidden="true" />
              Revoke all
            </Button>
          ) : null}
        </div>

        {sessions.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-description text-foreground-muted">
            No active sessions.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sessions.map((session, index) => (
              <SessionRowItem
                key={session.id}
                sessionId={session.id}
                ownerId={user.id}
                device={describeDevice(session.userAgent)}
                ip={session.ipAddress}
                createdAt={session.createdAt}
                lastActiveAt={session.lastActiveAt}
                index={index}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-section-title text-foreground">Activity</h2>
        {activity.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-description text-foreground-muted">
            No recorded activity yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {activity.map((entry) => (
              <li
                key={`${entry.kind}-${entry.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-secondary px-4 py-2.5 text-caption"
              >
                <span className="flex items-center gap-2 text-foreground">
                  {entry.kind === "auth" ? (
                    <LogIn className="size-3.5 text-foreground-subtle" aria-hidden="true" />
                  ) : (
                    <Activity className="size-3.5 text-foreground-subtle" aria-hidden="true" />
                  )}
                  {entry.action.replace(/_/g, " ")}
                  {entry.entity ? (
                    <span className="text-foreground-subtle">· {entry.entity}</span>
                  ) : null}
                </span>
                <span className="text-foreground-subtle">{formatDateTime(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-section-title text-foreground">Login history</h2>
        {loginHistory.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-description text-foreground-muted">
            No sign-in events recorded yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {loginHistory.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-secondary px-4 py-2.5 text-caption"
              >
                <span className="flex items-center gap-2 text-foreground">
                  {entry.eventType === "login_failed" ? (
                    <KeyRound className="size-3.5 text-danger" aria-hidden="true" />
                  ) : entry.eventType === "logout" ? (
                    <LogOut className="size-3.5 text-foreground-subtle" aria-hidden="true" />
                  ) : (
                    <LogIn className="size-3.5 text-success" aria-hidden="true" />
                  )}
                  {entry.eventType.replace(/_/g, " ")}
                  {entry.ipAddress ? (
                    <span className="font-mono text-foreground-subtle">{entry.ipAddress}</span>
                  ) : null}
                </span>
                <span className="text-foreground-subtle">{formatDateTime(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SessionRowItem({
  sessionId,
  ownerId,
  device,
  ip,
  createdAt,
  lastActiveAt,
  index,
}: {
  sessionId: string;
  ownerId: string;
  device: string;
  ip: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  index: number;
}) {
  const router = useRouter();

  const revoke = useMutation({
    mutationFn: async () => unwrap(await revokeSessionAction(sessionId, ownerId)),
    onSuccess: () => {
      toast.success("Session revoked");
      router.refresh();
    },
    onError: (error) => toast.error("Could not revoke", { description: error.userMessage }),
  });

  return (
    <motion.li
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: DURATION.fast,
        ease: EASING.standard,
        delay: Math.min(index * 0.03, 0.15),
      }}
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-3">
        <Monitor className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-description text-foreground">{device}</span>
          <span className="text-caption text-foreground-subtle">
            {ip ? <span className="font-mono">{ip}</span> : "No IP"} · started{" "}
            {formatDateTime(createdAt)} · active {formatDateTime(lastActiveAt)}
          </span>
        </div>
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={() => revoke.mutate()}
        disabled={revoke.isPending}
      >
        Revoke
      </Button>
    </motion.li>
  );
}
