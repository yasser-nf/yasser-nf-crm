import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { PAGINATION } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/errors";
import {
  ProblemsFilters,
  ProblemsTable,
  problemsService,
  type ProblemFilter,
} from "@/modules/problems";
import { usersService } from "@/modules/users";
import { ErrorState } from "@/shared/feedback/error-state";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Problems" };

/**
 * Problems list.
 *
 * Visibility is global — every signed-in staff member sees every problem — so
 * this page shows the same rows to a Worker and a Super Admin. What differs is
 * what they can change, and that is decided per row inside the services.
 */

const STATUSES = ["open", "in_progress", "waiting", "resolved", "closed", "cancelled"] as const;
const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const TYPES = [
  "payment_problem",
  "incorrect_password",
  "invalid_email",
  "something_went_wrong",
  "other",
] as const;
const SORTS = ["createdAt", "updatedAt", "severity", "status"] as const;

/** Query strings are user input; every value is matched against a known set. */
function parseSearchParams(params: Record<string, string | string[] | undefined>): ProblemFilter {
  const read = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const offsetRaw = Number.parseInt(read("offset") ?? "0", 10);
  const from = read("from");
  const createdAfter = from ? new Date(from) : undefined;

  return {
    search: read("search"),
    status: STATUSES.find((status) => status === read("status")),
    severity: SEVERITIES.find((severity) => severity === read("severity")),
    issueType: TYPES.find((type) => type === read("type")),
    assignedTo: read("assignedTo"),
    ...(createdAfter && !Number.isNaN(createdAfter.getTime()) ? { createdAfter } : {}),
    sortBy: SORTS.find((sort) => sort === read("sortBy")) ?? "createdAt",
    sortDirection: read("dir") === "asc" ? "asc" : "desc",
    offset: Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0,
    limit: PAGINATION.DEFAULT_PAGE_SIZE,
  };
}

export default async function ProblemsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseSearchParams(await searchParams);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title text-foreground">Problems</h1>
        <p className="text-description text-foreground-muted">
          Every account fault, who is on it, and what is blocked while it is open.
        </p>
      </header>

      <Suspense fallback={<Skeleton className="h-11 w-full max-w-sm" />}>
        <FiltersRow />
      </Suspense>

      <Suspense key={JSON.stringify(filter)} fallback={<TableSkeleton />}>
        <ProblemsList filter={filter} />
      </Suspense>
    </div>
  );
}

/**
 * The worker filter needs the list of people.
 *
 * Read through the users module's public API rather than joining here — the
 * problems module does not own user data, and reaching into another module's
 * tables would couple them. A Worker cannot list users, so an empty list is a
 * valid outcome and the filter simply offers nobody.
 */
async function FiltersRow() {
  const actor = await getCurrentUser();
  const result = await usersService.list({ limit: 100, offset: 0 }, actor);

  const workers = result.ok
    ? result.value.items.map((entry) => ({ id: entry.user.id, name: entry.user.name }))
    : [];

  return <ProblemsFilters workers={workers} />;
}

async function ProblemsList({ filter }: { filter: ProblemFilter }) {
  const actor = await getCurrentUser();
  const result = await problemsService.list(filter, actor);

  if (!result.ok) {
    if (result.error instanceof ForbiddenError) {
      return (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-16 text-center">
          <ShieldAlert className="size-6 text-foreground-subtle" aria-hidden="true" />
          <h2 className="text-section-title text-foreground">Not available to your role</h2>
          <p className="max-w-sm text-description text-foreground-muted">
            You do not have permission to view problems.
          </p>
        </div>
      );
    }

    return <ErrorState error={result.error} title="Could not load problems" />;
  }

  return (
    <ProblemsTable
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
