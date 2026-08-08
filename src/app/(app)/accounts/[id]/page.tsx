import { ArrowLeft, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ROUTES } from "@/config/constants";
import { NotFoundError } from "@/lib/errors";
import { AccountHeader, AccountTimeline, ProfileCard, accountsService } from "@/modules/accounts";
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

  const { account, profiles, accountAllowsAllocation, hasProfileCountAnomaly } = detail.value;

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
              This account is not Healthy, so none of its five profiles can be allocated — whatever
              their individual status says.
            </p>
          </div>
        </div>
      ) : null}

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

      <section className="flex flex-col gap-4">
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
