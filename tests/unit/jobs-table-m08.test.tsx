/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JobListItem } from "@/modules/jobs/services/job-view";

/**
 * The jobs page's list (M08 jobs): every state a job can be shown in, the
 * empty and filtered-empty answers, and who sees the Cancel button.
 */

const cancelJobAction = vi.fn();

vi.mock("@/modules/jobs/actions/jobs.actions", () => ({
  cancelJobAction: (...args: unknown[]) => cancelJobAction(...args),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/jobs",
  useSearchParams: () => new URLSearchParams(),
}));

const { JobsTable } = await import("@/modules/jobs/components/jobs-table");

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const base: JobListItem = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  type: "netflix.verify_account",
  status: "queued",
  state: "queued",
  priority: "normal",
  attempts: 0,
  maxAttempts: 3,
  createdAt: "2026-06-17T10:30:00.000Z",
  availableAt: "2026-06-17T10:30:00.000Z",
  startedAt: null,
  heartbeatAt: null,
  finishedAt: null,
  cancelledAt: null,
  recoveredAt: null,
  claimedBy: null,
  lastError: null,
  lastErrorCode: null,
  cancellable: true,
};

const job = (overrides: Partial<JobListItem>): JobListItem => ({ ...base, ...overrides });

afterEach(() => {
  cleanup();
  cancelJobAction.mockReset();
});

describe("the jobs list", () => {
  it("names every state, and marks a recovered job", () => {
    const items = [
      job({ id: "a1", state: "queued" }),
      job({ id: "a2", state: "retrying", attempts: 1, lastError: "A network connection failed." }),
      job({ id: "a3", status: "running", state: "running", cancellable: false, claimedBy: "w-1" }),
      job({ id: "a4", status: "running", state: "stale", cancellable: false }),
      job({ id: "a5", status: "succeeded", state: "succeeded", cancellable: false }),
      job({
        id: "a6",
        status: "failed",
        state: "failed",
        cancellable: false,
        recoveredAt: "2026-06-17T10:40:00.000Z",
      }),
      job({ id: "a7", status: "cancelled", state: "cancelled", cancellable: false }),
    ];

    wrap(<JobsTable items={items} total={7} limit={25} offset={0} filtered={false} canManage />);

    for (const label of [
      "Queued",
      "Retrying",
      "Running",
      "Stale",
      "Succeeded",
      "Failed",
      "Cancelled",
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText("Recovered").length).toBeGreaterThan(0);
    expect(screen.getByText("7 jobs · page 1 of 1")).toBeTruthy();
  });

  it("says why it is empty: nothing yet, nothing matching, or past the last page", () => {
    wrap(<JobsTable items={[]} total={0} limit={25} offset={0} filtered={false} canManage />);
    expect(screen.getByText("No jobs yet")).toBeTruthy();
    cleanup();

    wrap(<JobsTable items={[]} total={0} limit={25} offset={0} filtered canManage />);
    expect(screen.getByText("No jobs match these filters")).toBeTruthy();
    cleanup();

    wrap(<JobsTable items={[]} total={30} limit={25} offset={50} filtered={false} canManage />);
    expect(screen.getByText("No jobs on this page")).toBeTruthy();
  });

  it("offers Cancel only for a queued job, and only to someone who may manage jobs", async () => {
    cancelJobAction.mockResolvedValue({ ok: true, data: { ...base, status: "cancelled" } });

    wrap(<JobsTable items={[base]} total={1} limit={25} offset={0} filtered={false} canManage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Cancel job" }));
    await waitFor(() => expect(cancelJobAction).toHaveBeenCalledWith(base.id));
    cleanup();

    wrap(
      <JobsTable
        items={[base]}
        total={1}
        limit={25}
        offset={0}
        filtered={false}
        canManage={false}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0]!);
    expect(screen.queryByRole("button", { name: "Cancel job" })).toBeNull();
    cleanup();

    const running = job({ status: "running", state: "running", cancellable: false });
    wrap(
      <JobsTable items={[running]} total={1} limit={25} offset={0} filtered={false} canManage />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0]!);
    expect(screen.queryByRole("button", { name: "Cancel job" })).toBeNull();
    expect(screen.getByText(/running job cannot be cancelled/)).toBeTruthy();
  });
});
