import { ArrowLeft, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ROUTES } from "@/config/constants";
import { NotFoundError } from "@/lib/errors";
import { AccountHeader, AccountTimeline, ProfileCard, accountsService } from "@/modules/accounts";
import type { AccountRow } from "@/lib/drizzle/schema";
import type { ProfileAllocation } from "@/modules/accounts";
import { ProblemSeverityBadge, ProblemStatusBadge, ReportProblemDialog } from "@/modules/problems";
import { ReplaceAccountButton } from "@/modules/quick-prepare";
import { ErrorState } from "@/shared/feedback/error-state";

export const metadata: Metadata = {
  title: "Account",
};

/**
 * Account details.
 *
 * Shows the account, its five profile cards, and the timeline built from
 * profile_events.
 *
 * The password is deliberately absent from this payload. ADR-006 Decision 4:
 * it is fetched by a separate action when someone clicks to reveal it, so a
 * page view never puts a credential in the HTML.
 */
/**
 * Offers replacement to every customer stranded on a broken account.
 *
 * Rendered only for the four fault statuses — the button itself returns null
 * otherwise, so a healthy account shows nothing.
 *
 * Grouped by customer because replacement moves one customer's whole holding at
 * once. A customer with three profiles on this account gets one button, not
 * three, and their three profiles land together on the new account.
 */
function ReplaceAllocations({
  account,
  profiles,
}: {
  account: AccountRow;
  profiles: readonly ProfileAllocation[];
}) {
  const byCustomer = new Map<string, number>();

  for (const { profile } of profiles) {
    if (profile.customerId) {
      byCustomer.set(profile.customerId, (byCustomer.get(profile.customerId) ?? 0) + 1);
    }
  }

  if (byCustomer.size === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-section-title text-foreground">Affected customers</h2>
        <p className="text-caption text-foreground-muted">
          Move a customer to healthy stock. They keep their original expiration date.
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {[...byCustomer.entries()].map(([customerId, count], index) => (
          <li
            key={customerId}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-background-secondary px-4 py-3"
          >
            <span className="text-description text-foreground">
              Customer {index + 1} · {count} profile{count === 1 ? "" : "s"}
            </span>

            <ReplaceAccountButton
              account={account}
              customerId={customerId}
              customerLabel={`customer ${index + 1}`}
              profileCount={count}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const detail = await accountsService.getAccountDetail(id);

  if (!detail.ok) {
    /*
     * A missing account is a 404, not an error banner. Anything else genuinely
     * failed and should say so.
     */
    if (detail.error instanceof NotFoundError) {
      notFound();
    }

    return <ErrorState error={detail.error} title="Could not load this account" />;
  }

  const { account, profiles, accountAllowsAllocation, hasProfileCountAnomaly, activeProblems } =
    detail.value;

  const timeline = await accountsService.getAccountTimeline(id, { limit: 25 });

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={ROUTES.ACCOUNTS}
        className="inline-flex w-fit items-center gap-1.5 text-caption text-foreground-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        All accounts
      </Link>

      <AccountHeader account={account} />

      {!accountAllowsAllocation ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning-subtle p-4"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <p className="text-card-title text-foreground">All profiles are blocked</p>
            <p className="text-caption text-foreground-muted">
              {activeProblems.length > 0
                ? `${activeProblems.length} open problem${activeProblems.length === 1 ? "" : "s"} on this account. None of its five profiles can be allocated until they are resolved.`
                : "This account is not Healthy, so none of its five profiles can be allocated — whatever their individual status says."}
            </p>
          </div>
        </div>
      ) : null}

      {/*
        Problems are reported and resolved only through the Problems module. This
        screen links into it rather than acting on problems itself — the M08 rule
        that no module creates or resolves a problem directly.
      */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-section-title text-foreground">Problems</h2>
          <ReportProblemDialog accountId={account.id} accountEmail={account.email} />
        </div>

        {activeProblems.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-6 py-6 text-center text-caption text-foreground-muted">
            No open problems on this account.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {activeProblems.map((problem) => (
              <li key={problem.id}>
                <Link
                  href={`${ROUTES.PROBLEMS}/${problem.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3 transition-colors hover:bg-surface-raised"
                >
                  <span className="flex items-center gap-2 text-description text-foreground">
                    <ProblemSeverityBadge severity={problem.severity} />
                    {problem.description.slice(0, 80)}
                    {problem.description.length > 80 ? "…" : ""}
                  </span>
                  <ProblemStatusBadge status={problem.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {hasProfileCountAnomaly ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-danger/30 bg-danger-subtle p-4"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <p className="text-card-title text-foreground">Unexpected profile count</p>
            <p className="text-caption text-foreground-muted">
              This account has {profiles.length} profiles instead of five. That should be impossible
              through the application, so the data likely arrived from an import.
            </p>
          </div>
        </div>
      ) : null}

      <ReplaceAllocations account={account} profiles={profiles} />

      <section className="flex flex-col gap-4">
        <h2 className="text-section-title text-foreground">Profiles</h2>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {profiles.map((allocation, index) => (
            <ProfileCard
              key={allocation.profile.id}
              allocation={allocation}
              accountId={account.id}
              /*
               * Customer names arrive with the Customers module. Showing the raw
               * id would be worse than showing nothing.
               */
              customerLabel={allocation.profile.customerId ? "Assigned" : null}
              index={index}
            />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4" id="timeline">
        <h2 className="text-section-title text-foreground">Timeline</h2>

        {timeline.ok ? (
          <AccountTimeline events={timeline.value.items} />
        ) : (
          <ErrorState error={timeline.error} title="Could not load the timeline" />
        )}
      </section>
    </div>
  );
}
