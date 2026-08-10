import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { USER_ROLES } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { ProblemDetailView, problemTimelineService, problemsService } from "@/modules/problems";
import { ErrorState } from "@/shared/feedback/error-state";

export const metadata: Metadata = { title: "Problem" };

/**
 * Problem detail.
 *
 * The timeline is fetched only here, never in the list — the M08 performance
 * rule. It is loaded in parallel with the problem itself rather than after it,
 * since neither read depends on the other.
 */
export default async function ProblemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getCurrentUser();

  const [detail, timeline] = await Promise.all([
    problemsService.getDetail(id, actor),
    problemTimelineService.forProblem(id, actor),
  ]);

  if (!detail.ok) {
    if (detail.error instanceof ForbiddenError) {
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

    if (detail.error instanceof NotFoundError) {
      notFound();
    }

    return <ErrorState error={detail.error} title="Could not load this problem" />;
  }

  return (
    <ProblemDetailView
      entry={detail.value}
      timeline={timeline.ok ? timeline.value : []}
      viewer={{
        id: actor?.id ?? "",
        isSuperAdmin: actor?.role === USER_ROLES.SUPER_ADMIN,
      }}
    />
  );
}
