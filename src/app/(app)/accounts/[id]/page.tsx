import { ArrowLeft, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ROUTES } from "@/config/constants";
import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import {
  AccountHeader,
  AccountTimeline,
  ProfileCard,
  ProfileIndicatorLegend,
  ProfileIndicators,
  accountsService,
} from "@/modules/accounts";
import type { AccountRow } from "@/lib/drizzle/schema";
import { profileCustomerLabel, type ProfileAllocationWithCustomer } from "@/modules/accounts";
import { PROBLEM_TYPE_LABELS, ProblemStatusBadge, ReportProblemDialog } from "@/modules/problems";
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
  /* Only what the button reads. Keeps the credential off this page entirely. */
  /* `email` is how the replacement preview looks the account up. */
  account: Pick<AccountRow, "id" | "status" | "email">;
  profiles: readonly ProfileAllocationWithCustomer[];
}) {
  /*
   * Grouped by the customer each profile actually names, and carrying that
   * customer's label. "Customer 1", "Customer 2" told an operator nothing about
   * who they were being asked to move — they had to open the customer page to
   * find out which of their people was affected.
   */
  const byCustomer = new Map<string, { count: number; label: string }>();

  for (const { profile, customer } of profiles) {
    if (!profile.customerId) continue;

    const existing = byCustomer.get(profile.customerId);

    if (existing) {
      existing.count += 1;
    } else {
      byCustomer.set(profile.customerId, {
        count: 1,
        label: profileCustomerLabel(customer),
      });
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
        {[...byCustomer.entries()].map(([customerId, { count, label }]) => (
          <li
            key={customerId}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-background-secondary px-4 py-3"
          >
            <span className="text-description text-foreground">
              <span className="font-mono">{label}</span> · {count} profile
              {count === 1 ? "" : "s"}
            </span>

            <ReplaceAccountButton
              account={account}
              customerId={customerId}
              customerLabel={label}
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

  const {
    account,
    profiles,
    indicators,
    accountAllowsAllocation,
    hasProfileCountAnomaly,
    activeProblems,
    effectiveStatus,
    remainingValidityDays,
  } = detail.value;

  /*
   * Decided here so the control is absent, not merely disabled, for anyone who
   * may not use it. `profilesService.unassignSale` checks the same permission —
   * this governs what is offered, never what is allowed.
   */
  const actor = await getCurrentUser();
  const canUnassignSale =
    actor !== null && roleHasPermission(actor.role, PERMISSIONS.UNASSIGN_SALES);

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

      <AccountHeader
        account={account}
        remainingValidityDays={remainingValidityDays}
        effectiveStatus={effectiveStatus}
      />

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
                ? `${activeProblems.length} open problem${activeProblems.length === 1 ? "" : "s"} on this account. None of its five profiles can be allocated, and it is listed under Problems rather than Accounts, until they are resolved.`
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
                  {/*
                    The account and the problem, nothing else (M03). Severity and
                    the free-text description are still stored — they are history
                    — but the workflow acts on the type, and every problem listed
                    here is blocking by construction: activeProblems holds only
                    blocking statuses.
                  */}
                  <span className="text-description font-medium text-foreground">
                    {PROBLEM_TYPE_LABELS[problem.issueType] ?? problem.issueType}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-caption text-danger">Blocks allocation</span>
                    <ProblemStatusBadge status={problem.status} />
                    {/*
                      Resolution lives on the problem, through its lifecycle —
                      never by editing the account's status. Resolving the last
                      blocking problem returns this account to the Accounts list.
                    */}
                    <span className="text-caption text-primary">Open to resolve &rarr;</span>
                  </span>
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-section-title text-foreground">Profiles</h2>

          {/*
            The same P1..P5 strip as the accounts list, from the same
            `profileCellState` derivation. M13 §7: one interpretation.
          */}
          <div className="flex flex-wrap items-center gap-4">
            <ProfileIndicators indicators={indicators} />
            <ProfileIndicatorLegend />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {profiles.map((allocation, index) => (
            <ProfileCard
              key={allocation.profile.id}
              allocation={allocation}
              accountId={account.id}
              canUnassignSale={canUnassignSale}
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
