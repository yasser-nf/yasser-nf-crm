import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ROUTES } from "@/config/constants";
import { USER_ROLES } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import { CustomerDetailView, customersService } from "@/modules/customers";
import { PROBLEM_TYPE_LABELS, ProblemStatusBadge, problemsService } from "@/modules/problems";
import { ErrorState } from "@/shared/feedback/error-state";

export const metadata: Metadata = { title: "Customer" };

/**
 * Customer details.
 *
 * `canAdminister` only decides what the UI offers. Blocking and archiving are
 * enforced in the service, so hiding the buttons is a convenience rather than
 * the control — a Server Action is an endpoint anyone with a session can call
 * directly.
 */
export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [detail, actor] = await Promise.all([customersService.getDetail(id), getCurrentUser()]);

  if (!detail.ok) {
    if (detail.error instanceof NotFoundError) {
      notFound();
    }

    return <ErrorState error={detail.error} title="Could not load this customer" />;
  }

  /*
   * Active problems on the accounts this customer currently holds a profile on.
   * Read through the Problems module's public API — the customers module does
   * not own problems and must not query them.
   */
  const problems = await problemsService.activeForCustomer(id, actor);

  return (
    <div className="flex flex-col gap-6">
      <CustomerDetailView
        detail={detail.value}
        canAdminister={actor?.role === USER_ROLES.SUPER_ADMIN}
      />

      {problems.ok && problems.value.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-section-title text-foreground">Active problems</h2>
          <p className="text-caption text-foreground-muted">
            Faults on accounts this customer is currently on. Their profiles keep working; the
            account cannot be used for new allocations until these are resolved.
          </p>

          <ul className="flex flex-col gap-2">
            {problems.value.map((entry) => (
              <li key={entry.problem.id}>
                <Link
                  href={`${ROUTES.PROBLEMS}/${entry.problem.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3 transition-colors hover:bg-surface-raised"
                >
                  <span className="flex flex-wrap items-center gap-2 text-description text-foreground">
                    {PROBLEM_TYPE_LABELS[entry.problem.issueType] ?? entry.problem.issueType}
                    <span className="text-caption text-foreground-muted">{entry.accountEmail}</span>
                  </span>
                  <ProblemStatusBadge status={entry.problem.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
