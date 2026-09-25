/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Logs table and its detail dialog (M06): the empty state that is true
 * for the question asked, paging, and a detail view with nothing to leak.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => "/logs",
  useSearchParams: () => new URLSearchParams("entity=issue"),
}));

const { LogsTable } = await import("@/modules/audit/components/logs-table");
const { toLogEntry } = await import("@/modules/audit/services/log-view");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const entry = toLogEntry({
  id: "11111111-1111-4111-8111-111111111111",
  createdAt: new Date("2026-09-25T14:42:31Z"),
  entity: "issue",
  entityId: "22222222-2222-4222-8222-222222222222",
  action: "update",
  before: { status: "open", resolutionNote: null },
  after: { status: "resolved", resolutionNote: "reset it to Hunter2 and it worked" },
  userId: "33333333-3333-4333-8333-333333333333",
  actorEmail: "yasser@example.com",
  actorName: "Yasser",
  actorCurrentEmail: "yasser@example.com",
  ipAddress: "10.0.0.1",
  userAgent: "Mozilla/5.0",
});

describe("empty states say what is true", () => {
  it("no entries at all", () => {
    render(<LogsTable items={[]} total={0} limit={25} offset={0} filtered={false} />);

    expect(screen.getByText("No audit entries yet")).toBeTruthy();
  });

  it("filters that match nothing — with a way out", () => {
    render(<LogsTable items={[]} total={0} limit={25} offset={0} filtered />);

    expect(screen.getByText("No entries match these filters")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(push).toHaveBeenCalledWith("/logs");
  });

  it("a page past the end is not 'no entries'", () => {
    render(<LogsTable items={[]} total={40} limit={25} offset={75} filtered={false} />);

    expect(screen.getByText("No entries on this page")).toBeTruthy();
  });
});

describe("the table", () => {
  it("shows UTC time, person, action, entity and summary", () => {
    render(<LogsTable items={[entry]} total={1} limit={25} offset={0} filtered={false} />);

    expect(screen.getAllByText("2026-09-25 14:42:31").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Yasser").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Updated problem: status, resolution note").length).toBeGreaterThan(
      0,
    );
  });

  it("pages forward keeping the filters", () => {
    render(<LogsTable items={[entry]} total={60} limit={25} offset={0} filtered />);

    expect(screen.getByText("60 entries · page 1 of 3")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(push).toHaveBeenCalledWith("/logs?entity=issue&offset=25");
  });
});

describe("the detail dialog", () => {
  it("shows the change and hides the typed note", () => {
    render(<LogsTable items={[entry]} total={1} limit={25} offset={0} filtered={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("resolved")).toBeTruthy();
    expect(within(dialog).getByText("Text hidden (33 characters)")).toBeTruthy();
    expect(dialog.textContent).not.toContain("Hunter2");
    expect(
      within(dialog)
        .getByRole("link", { name: /Open problem/ })
        .getAttribute("href"),
    ).toBe("/problems/22222222-2222-4222-8222-222222222222");
  });
});
