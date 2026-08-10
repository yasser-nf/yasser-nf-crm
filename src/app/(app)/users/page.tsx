import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { PAGINATION } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/errors";
import {
  InviteUserButton,
  OnlineNow,
  UsersFilters,
  UsersTable,
  usersService,
  type UserFilter,
} from "@/modules/users";
import { ErrorState } from "@/shared/feedback/error-state";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Users" };

/**
 * Users list.
 *
 * The service performs the authorization check, so a Worker reaching this URL
 * gets a refusal from the same code path a direct Server Action call would hit.
 * The page renders that refusal rather than deciding anything itself.
 */

const ROLES = ["super_admin", "worker"] as const;
const STATUSES = ["active", "suspended", "disabled"] as const;

/** Query strings are user input; every value is matched against a known set. */
function parseSearchParams(params: Record<string, string | string[] | undefined>): UserFilter {
  const read = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const offsetRaw = Number.parseInt(read("offset") ?? "0", 10);

  return {
    search: read("search"),
    role: ROLES.find((role) => role === read("role")),
    status: STATUSES.find((status) => status === read("status")),
    sortBy: "createdAt",
    sortDirection: "desc",
    offset: Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0,
    limit: PAGINATION.DEFAULT_PAGE_SIZE,
  };
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseSearchParams(await searchParams);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-page-title text-foreground">Users</h1>
          <p className="text-description text-foreground-muted">
            Everyone with access to the CRM, and what they can do.
          </p>
        </div>

        <InviteUserButton />
      </header>

      {/* Streams separately: a slow session read must not hold up the table. */}
      <Suspense fallback={<Skeleton className="h-6 w-52" />}>
        <OnlineNowStrip />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-11 w-full max-w-sm" />}>
        <UsersFilters />
      </Suspense>

      <Suspense key={JSON.stringify(filter)} fallback={<TableSkeleton />}>
        <UsersList filter={filter} />
      </Suspense>
    </div>
  );
}

/**
 * Presence strip.
 *
 * Renders nothing at all on refusal or failure. It is supplementary information,
 * and a Worker who lands here should see one refusal from the list below, not a
 * second one stacked above it.
 */
async function OnlineNowStrip() {
  const actor = await getCurrentUser();
  const result = await usersService.onlineNow(actor);

  if (!result.ok) {
    return null;
  }

  return <OnlineNow entries={result.value} />;
}

async function UsersList({ filter }: { filter: UserFilter }) {
  const actor = await getCurrentUser();
  const result = await usersService.list(filter, actor);

  if (!result.ok) {
    /*
     * A refusal is not an error state. Showing "something went wrong" to a
     * Worker who simply lacks permission would send them chasing a bug.
     */
    if (result.error instanceof ForbiddenError) {
      return (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-16 text-center">
          <ShieldAlert className="size-6 text-foreground-subtle" aria-hidden="true" />
          <h2 className="text-section-title text-foreground">Not available to your role</h2>
          <p className="max-w-sm text-description text-foreground-muted">
            User management is restricted to Super Admins.
          </p>
        </div>
      );
    }

    return <ErrorState error={result.error} title="Could not load users" />;
  }

  return (
    <UsersTable
      items={result.value.items}
      total={result.value.total}
      limit={result.value.limit}
      offset={result.value.offset}
    />
  );
}

/** 04_UI_GUIDELINES.md: skeletons, never spinners, matching the real layout. */
function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-11 w-full" />
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  );
}
