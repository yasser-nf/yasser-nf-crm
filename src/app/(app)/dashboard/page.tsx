import type { Metadata } from "next";

import { getCurrentUser } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Dashboard",
};

/**
 * Dashboard placeholder.
 *
 * CURRENT_MILESTONE.md task 24: welcome and "System Ready". Nothing else.
 *
 * Widgets, metrics and stock summaries belong to the milestones that own the
 * data behind them. Building a chart here would mean inventing data that does
 * not exist yet.
 */
export default async function DashboardPage() {
  const user = await getCurrentUser();

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-page-title text-foreground">
        Welcome{user ? `, ${user.displayName}` : ""}
      </h1>
      <p className="text-description text-foreground-muted">System Ready.</p>
    </div>
  );
}
