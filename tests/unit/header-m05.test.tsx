/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two M05 header components, rendered.
 *
 * What they must say in each state — and above all what they must not: a
 * failed count is never "0", a failed list is never "no notifications", and a
 * failed search is never "no results".
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => "/dashboard",
}));

const getNotificationsAction = vi.fn();
const markNotificationReadAction = vi.fn();
const markAllNotificationsReadAction = vi.fn();
vi.mock("@/modules/notifications/actions/notification.actions", () => ({
  getNotificationsAction: () => getNotificationsAction(),
  markNotificationReadAction: (id: string) => markNotificationReadAction(id),
  markAllNotificationsReadAction: () => markAllNotificationsReadAction(),
}));

const globalSearchAction = vi.fn();
vi.mock("@/modules/search/actions/search.actions", () => ({
  globalSearchAction: (query: string) => globalSearchAction(query),
}));

/* Who is signed in. Mutable so a test can hand the same tab to someone else. */
let currentUser = { id: "00000000-0000-4000-8000-00000000000a", role: "super_admin" };
vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: currentUser, isAuthenticated: true }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const { NotificationCenter } =
  await import("@/modules/notifications/components/notification-center");
const { GlobalSearch } = await import("@/modules/search/components/global-search");

function renderWithQuery(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const PROBLEM = "22222222-2222-4222-8222-222222222222";
const UNREAD = {
  id: "33333333-3333-4333-8333-333333333333",
  type: "problem_assigned",
  title: "Assigned to you: Payment problem",
  body: "one@icloud.com — assigned by Admin",
  href: `/problems/${PROBLEM}`,
  read: false,
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  markNotificationReadAction.mockResolvedValue({ ok: true, data: true });
  markAllNotificationsReadAction.mockResolvedValue({ ok: true, data: 1 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openPanel() {
  const trigger = screen.getByRole("button", { name: /Notifications/ });
  fireEvent.keyDown(trigger, { key: "Enter" });
}

describe("NotificationCenter", () => {
  it("shows the unread count on the bell", async () => {
    getNotificationsAction.mockResolvedValue({
      ok: true,
      data: { items: [UNREAD], unreadCount: 3 },
    });

    renderWithQuery(<NotificationCenter />);

    expect(await screen.findByRole("button", { name: "Notifications — 3 unread" })).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("a failed read shows a warning, never 0, and the panel says it failed", async () => {
    getNotificationsAction.mockResolvedValue({
      ok: false,
      message: "down",
      code: "DATABASE_ERROR",
    });

    renderWithQuery(<NotificationCenter />);

    await screen.findByRole("button", { name: "Notifications — could not be loaded" });
    expect(screen.queryByText("0")).toBeNull();

    openPanel();

    expect(await screen.findByText("Notifications could not be loaded.")).toBeTruthy();
    expect(screen.queryByText("You have no notifications.")).toBeNull();
  });

  it("an empty inbox is a real empty state", async () => {
    getNotificationsAction.mockResolvedValue({ ok: true, data: { items: [], unreadCount: 0 } });

    renderWithQuery(<NotificationCenter />);
    await screen.findByRole("button", { name: "Notifications" });
    openPanel();

    expect(await screen.findByText("You have no notifications.")).toBeTruthy();
  });

  it("opening an unread notification marks it read and goes to its page", async () => {
    getNotificationsAction.mockResolvedValue({
      ok: true,
      data: { items: [UNREAD], unreadCount: 1 },
    });

    renderWithQuery(<NotificationCenter />);
    await screen.findByRole("button", { name: "Notifications — 1 unread" });
    openPanel();

    fireEvent.click(await screen.findByText("Assigned to you: Payment problem"));

    await waitFor(() => expect(markNotificationReadAction).toHaveBeenCalledWith(UNREAD.id));
    expect(push).toHaveBeenCalledWith(`/problems/${PROBLEM}`);
  });

  it("never shows one person's cached notifications to the next person on the same tab", async () => {
    /* One query client for both, as in the browser: it outlives a session ending. */
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = (node: React.ReactNode) => (
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    );

    getNotificationsAction.mockResolvedValueOnce({
      ok: true,
      data: { items: [UNREAD], unreadCount: 3 },
    });
    const first = render(wrap(<NotificationCenter />));
    await screen.findByRole("button", { name: "Notifications — 3 unread" });
    first.unmount();

    /* Someone else signs in on this tab, well inside the 30-second cache window. */
    currentUser = { id: "00000000-0000-4000-8000-00000000000b", role: "worker" };
    getNotificationsAction.mockResolvedValueOnce({ ok: true, data: { items: [], unreadCount: 0 } });
    render(wrap(<NotificationCenter />));

    expect(screen.queryByRole("button", { name: /3 unread/ })).toBeNull();
    await screen.findByRole("button", { name: "Notifications" });
    expect(getNotificationsAction).toHaveBeenCalledTimes(2);
    currentUser = { id: "00000000-0000-4000-8000-00000000000a", role: "super_admin" };
  });

  it("mark all as read calls the server once", async () => {
    getNotificationsAction.mockResolvedValue({
      ok: true,
      data: { items: [UNREAD], unreadCount: 1 },
    });

    renderWithQuery(<NotificationCenter />);
    await screen.findByRole("button", { name: "Notifications — 1 unread" });
    openPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Mark all as read" }));

    await waitFor(() => expect(markAllNotificationsReadAction).toHaveBeenCalledOnce());
  });
});

/* ------------------------------------------------------------------ search */

const RESPONSE = {
  query: "one",
  groups: [
    {
      kind: "accounts",
      label: "Accounts",
      status: "ok",
      hasMore: false,
      viewAllHref: null,
      hits: [
        {
          id: "a1",
          title: "one@icloud.com",
          subtitle: null,
          href: "/accounts/a1",
          badge: { label: "Healthy", className: "" },
        },
      ],
    },
    { kind: "customers", label: "Customers", status: "error" },
    {
      kind: "problems",
      label: "Problems",
      status: "ok",
      hasMore: false,
      viewAllHref: null,
      hits: [],
    },
  ],
};

function openSearch() {
  fireEvent.click(screen.getByRole("button", { name: /Search/ }));
  return screen.getByRole("combobox", { name: "Search" });
}

describe("GlobalSearch", () => {
  it("is idle below two characters and asks the server nothing", async () => {
    renderWithQuery(<GlobalSearch />);
    const input = openSearch();

    fireEvent.change(input, { target: { value: "o" } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));

    expect(screen.getByText("Type at least two characters to search.")).toBeTruthy();
    expect(globalSearchAction).not.toHaveBeenCalled();
  });

  it("opens with Ctrl+K", () => {
    renderWithQuery(<GlobalSearch />);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(screen.getByRole("combobox", { name: "Search" })).toBeTruthy();
  });

  it("shows grouped results; a failed group says so beside the others", async () => {
    globalSearchAction.mockResolvedValue({ ok: true, data: RESPONSE });

    renderWithQuery(<GlobalSearch />);
    fireEvent.change(openSearch(), { target: { value: "one" } });

    expect(await screen.findByText("one@icloud.com")).toBeTruthy();
    expect(screen.getByText("Accounts")).toBeTruthy();
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("Could not search customers.")).toBeTruthy();
    expect(screen.queryByText(/No results/)).toBeNull();
    expect(globalSearchAction).toHaveBeenCalledWith("one");
  });

  it("Enter opens the highlighted result", async () => {
    globalSearchAction.mockResolvedValue({ ok: true, data: RESPONSE });

    renderWithQuery(<GlobalSearch />);
    const input = openSearch();
    fireEvent.change(input, { target: { value: "one" } });
    await screen.findByText("one@icloud.com");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(push).toHaveBeenCalledWith("/accounts/a1");
  });

  it("a failed search is an error with Try again — never 'no results'", async () => {
    globalSearchAction.mockResolvedValue({
      ok: false,
      message: "Search is unavailable right now. Please try again.",
      code: "DATABASE_ERROR",
    });

    renderWithQuery(<GlobalSearch />);
    fireEvent.change(openSearch(), { target: { value: "one" } });

    /* The search retries once before it reports failure (global-search.tsx). */
    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toBeTruthy();
    expect(globalSearchAction).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Search is unavailable right now. Please try again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(/No results/)).toBeNull();
  });

  it("nothing matched is its own state", async () => {
    globalSearchAction.mockResolvedValue({
      ok: true,
      data: {
        query: "zzz",
        groups: [
          {
            kind: "accounts",
            label: "Accounts",
            status: "ok",
            hasMore: false,
            viewAllHref: null,
            hits: [],
          },
        ],
      },
    });

    renderWithQuery(<GlobalSearch />);
    fireEvent.change(openSearch(), { target: { value: "zzz" } });

    expect(await screen.findByText("No results for “zzz”.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
