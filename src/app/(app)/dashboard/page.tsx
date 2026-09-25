import type { Metadata } from "next";
import { Suspense } from "react";

import { getCurrentUser } from "@/lib/auth/session";
import {
  AccountsWidget,
  ActivityWidget,
  BackupWidget,
  ChartsWidget,
  CustomersWidget,
  ExpirationWidget,
  HealthWidget,
  OnlineUsersWidget,
  ProblemsCountsWidget,
  ProblemsListWidget,
  ProfilesWidget,
  QuickPrepareWidget,
  ReopenedWidget,
  RevenueWidget,
  StockWidget,
  presentStock,
  UsersCountsWidget,
  WidgetError,
  dashboardService,
} from "@/modules/dashboard";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The operational control centre.
 *
 * A Server Component throughout — every widget receives already-computed
 * numbers, so the page ships as HTML with no client JavaScript for the data
 * itself.
 *
 * Three independent Suspense boundaries rather than one. The counts, the stock
 * summary and the activity feed have different costs, and a single boundary
 * would hold the whole page at the speed of the slowest read. 04_UI_GUIDELINES:
 * never block the entire page.
 *
 * Authorization lives in the service. A Worker's payload simply does not
 * contain administrative metrics — they are absent from the response rather
 * than hidden in the markup, so they cannot be read out of the HTML.
 */
export default async function DashboardPage() {
  const user = await getCurrentUser();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title text-foreground">
          Welcome{user ? `, ${user.displayName}` : ""}
        </h1>
        <p className="text-description text-foreground-muted">
          Everything happening in the CRM right now.
        </p>
      </header>

      <Suspense fallback={<GridSkeleton count={6} />}>
        <Overview />
      </Suspense>

      <Suspense fallback={<GridSkeleton count={2} />}>
        <StockSection />
      </Suspense>

      <Suspense fallback={<GridSkeleton count={1} />}>
        <ActivitySection />
      </Suspense>
    </div>
  );
}

async function Overview() {
  const actor = await getCurrentUser();
  const result = await dashboardService.load(actor);

  if (!result.ok) {
    return <WidgetError message={result.error.userMessage} />;
  }

  const data = result.value;
  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      {data.canSeeAdminMetrics ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <HealthWidget health={data.health} />
          <BackupWidget backups={data.backups} now={now} />
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <AccountsWidget counts={data.counts.accounts} />
        <ProfilesWidget counts={data.counts.profiles} />
        <CustomersWidget counts={data.counts.customers} />
        <ProblemsCountsWidget counts={data.counts.problems} />
        <QuickPrepareWidget counts={data.counts.prepared} />
        <ExpirationWidget counts={data.counts.expirations} />

        {data.canSeeAdminMetrics ? (
          <UsersCountsWidget
            counts={data.counts.users}
            online={Array.isArray(data.onlineUsers) ? data.onlineUsers.length : null}
          />
        ) : null}

        <RevenueWidget />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ProblemsListWidget
          title="Newest problems"
          items={data.problems.newest}
          emptyMessage="No problems have been reported."
        />
        <ProblemsListWidget
          title="Critical"
          description="Open and critical"
          items={data.problems.critical}
          emptyMessage="Nothing critical is open."
        />
        <ProblemsListWidget
          title="Waiting longest"
          description="Parked, least recently touched first"
          items={data.problems.waitingLongest}
          emptyMessage="Nothing is waiting."
        />
        <ProblemsListWidget
          title="Assigned to me"
          items={data.problems.assignedToMe}
          emptyMessage="Nothing is assigned to you."
        />
        <ReopenedWidget items={data.problems.reopened} />
        {data.canSeeAdminMetrics ? <OnlineUsersWidget users={data.onlineUsers} /> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartsWidget
          accounts={data.charts.accountsOverTime}
          customers={data.charts.customersOverTime}
          types={data.charts.problemsByType}
          severity={data.charts.problemsBySeverity}
          backups={data.charts.backupsOverTime}
          canSeeBackups={data.canSeeAdminMetrics}
        />
      </div>
    </div>
  );
}

async function StockSection() {
  const actor = await getCurrentUser();
  const presentation = presentStock(await dashboardService.stock(actor));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {presentation.kind === "error" ? (
        <WidgetError message={presentation.message} />
      ) : (
        /*
         * Null still means forbidden, and now only forbidden. A failed query
         * used to arrive here as null too, which the widget rendered as "Not
         * available to your role" — a permission message for an outage.
         */
        <StockWidget stock={presentation.kind === "ready" ? presentation.stock : null} />
      )}
    </div>
  );
}

async function ActivitySection() {
  const actor = await getCurrentUser();
  const result = await dashboardService.activity(actor, 20, 0);

  if (!result.ok) {
    return <WidgetError message={result.error.userMessage} />;
  }

  return <ActivityWidget entries={result.value} />;
}

/** 04_UI_GUIDELINES.md: skeletons, never spinners, matching the real layout. */
function GridSkeleton({ count }: { count: number }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-40 w-full" />
      ))}
    </div>
  );
}
