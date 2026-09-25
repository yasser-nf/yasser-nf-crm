/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { AppUser } from "@/lib/auth";
import { fail, ok } from "@/utils/result";

/**
 * A failed backup read is an error on the dashboard (M04 review).
 *
 * It used to become `null`, which the Backups widget renders as "Not available
 * to your role" — for a Super Admin — and System health was then judged as if
 * no backup had ever completed. Both now say the read failed.
 */

const backupSummary = vi.fn();

vi.mock("@/modules/dashboard/repositories/dashboard.repository", () => ({
  dashboardRepository: {
    counts: async () =>
      ok({
        customers: { total: 0, active: 0, blocked: 0, archived: 0 },
        problems: {
          open: 0,
          waiting: 0,
          inProgress: 0,
          blocking: 0,
          accountsAffected: 0,
          paymentProblems: 0,
          paymentProblemAccounts: 0,
          resolvedToday: 0,
          critical: 0,
        },
        users: { active: 1, suspended: 0, disabled: 0 },
        prepared: { today: 0, yesterday: 0, thisWeek: 0, thisMonth: 0 },
      }),
    accountStateInputs: async () => ok([]),
    profileStateInputs: async () => ok([]),
    backupSummary: () => backupSummary(),
    reopenedProblems: async () => ok([]),
    accountsCreatedByDay: async () => ok([]),
    customersCreatedByDay: async () => ok([]),
    problemsByType: async () => ok([]),
    problemsBySeverity: async () => ok([]),
    backupsByDay: async () => ok([]),
  },
}));

vi.mock("@/modules/problems", () => ({
  problemsService: {
    list: async () => ok({ items: [], total: 0, limit: 5, offset: 0 }),
    accountsWithActiveProblems: async () => ok(new Map()),
  },
}));

vi.mock("@/modules/users", () => ({
  usersService: { onlineNow: async () => ok([]) },
}));

vi.mock("@/modules/quick-prepare", () => ({
  quickPrepareService: { availableStock: async () => ok(0) },
}));

const { dashboardService } = await import("@/modules/dashboard/services/dashboard.service");
const { BackupWidget, HealthWidget } =
  await import("@/modules/dashboard/components/dashboard-widgets");
const { DatabaseError } = await import("@/lib/errors");

const ADMIN: AppUser = {
  id: "a",
  email: "a@example.com",
  displayName: "A",
  initials: "A",
  role: "super_admin",
};
const WORKER: AppUser = { ...ADMIN, role: "worker" };

afterEach(cleanup);

describe("the service", () => {
  it("reports a failed backup read as an error, and health with it", async () => {
    backupSummary.mockResolvedValue(fail(new DatabaseError("backups unreadable")));

    const result = await dashboardService.load(ADMIN);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.backups).toBe("error");
      expect(result.value.health).toBe("error");
    }
  });

  it("still judges health from real facts when the read succeeds", async () => {
    backupSummary.mockResolvedValue(
      ok({
        lastBackupAt: new Date(),
        lastSnapshotAt: null,
        failed: 0,
        lastChecksumVerified: true,
        lastSizeBytes: 1,
        lastDurationMs: 1,
      }),
    );

    const result = await dashboardService.load(ADMIN);

    expect(result.ok && typeof result.value.health === "object").toBe(true);
  });

  it("gives a Worker neither — null, not an error", async () => {
    const result = await dashboardService.load(WORKER);

    expect(result.ok && result.value.backups).toBeNull();
    expect(result.ok && result.value.health).toBeNull();
  });
});

describe("the widgets", () => {
  it("say the read failed, not 'Not available to your role'", () => {
    render(
      <>
        <BackupWidget backups="error" now={new Date()} />
        <HealthWidget health="error" />
      </>,
    );

    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.queryByText("Not available to your role.")).toBeNull();
    expect(screen.queryByText("No backup has ever completed.")).toBeNull();
  });
});
