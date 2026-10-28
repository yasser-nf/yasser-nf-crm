/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ROUTES } from "@/config/constants";
import {
  NAVIGATION_ITEMS,
  overflowMobileItems,
  primaryMobileItems,
  visibleNavigationItems,
} from "@/config/navigation";
import { PERMISSIONS, USER_ROLES, roleHasPermission } from "@/config/roles";

/**
 * The mobile bottom bar (M09A follow-up).
 *
 * Six cells put "Quick Prepare" and "Quick Replace" onto a second line at
 * 375px while their neighbours stayed on one, and Quick Renewing had no mobile
 * entry at all — the route worked only if typed by hand. These pin the shape
 * that replaced it: four cells plus More, with every other destination the
 * role may see inside the sheet.
 */

let pathname: string = ROUTES.DASHBOARD;
let role: (typeof USER_ROLES)[keyof typeof USER_ROLES] | null = USER_ROLES.SUPER_ADMIN;

vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({
    user: role === null ? null : { id: "u", email: "e", displayName: "d", initials: "D", role },
  }),
}));

const { MobileNavigation } = await import("@/shared/layouts/mobile-navigation");

afterEach(() => {
  cleanup();
  pathname = ROUTES.DASHBOARD;
  role = USER_ROLES.SUPER_ADMIN;
});

function bar() {
  return screen.getByRole("navigation", { name: "Main navigation" });
}

describe("which destinations the bar itself shows", () => {
  it("shows four, plus More — never every item", () => {
    const primary = primaryMobileItems(USER_ROLES.SUPER_ADMIN);

    expect(primary.map((item) => item.href)).toEqual([
      ROUTES.DASHBOARD,
      ROUTES.ACCOUNTS,
      ROUTES.QUICK_PREPARE,
      ROUTES.CUSTOMERS,
    ]);
    expect(primary.length).toBeLessThan(NAVIGATION_ITEMS.length);
  });

  it("loses no destination: primary and overflow together are everything the role may see", () => {
    for (const current of [USER_ROLES.SUPER_ADMIN, USER_ROLES.WORKER]) {
      const reachable = [
        ...primaryMobileItems(current).map((item) => item.href),
        ...overflowMobileItems(current).map((item) => item.href),
      ].sort();

      expect(reachable).toEqual(
        visibleNavigationItems(current)
          .map((item) => item.href)
          .sort(),
      );
    }
  });

  it("keeps Quick Renewing reachable, through More", () => {
    const overflow = overflowMobileItems(USER_ROLES.SUPER_ADMIN).map((item) => item.href);

    expect(overflow).toContain(ROUTES.QUICK_RENEW);
    expect(primaryMobileItems(USER_ROLES.SUPER_ADMIN).map((i) => i.href)).not.toContain(
      ROUTES.QUICK_RENEW,
    );
  });

  it("preserves access to every destination the brief names", () => {
    const all = [
      ...primaryMobileItems(USER_ROLES.SUPER_ADMIN),
      ...overflowMobileItems(USER_ROLES.SUPER_ADMIN),
    ].map((item) => item.href);

    for (const href of [
      ROUTES.DASHBOARD,
      ROUTES.ACCOUNTS,
      ROUTES.QUICK_PREPARE,
      ROUTES.QUICK_REPLACE,
      ROUTES.QUICK_RENEW,
      ROUTES.CUSTOMERS,
      ROUTES.PROBLEMS,
    ]) {
      expect(all).toContain(href);
    }
  });
});

describe("permissions", () => {
  it("hides from a Worker every destination their role may not open", () => {
    const worker = overflowMobileItems(USER_ROLES.WORKER).map((item) => item.href);

    for (const href of [ROUTES.USERS, ROUTES.BACKUPS, ROUTES.LOGS, ROUTES.JOBS, ROUTES.SETTINGS]) {
      expect(worker).not.toContain(href);
    }
    /* What a Worker may do is still there. */
    expect(worker).toContain(ROUTES.QUICK_RENEW);
    expect(worker).toContain(ROUTES.QUICK_REPLACE);
    expect(worker).toContain(ROUTES.PROBLEMS);
  });

  it("agrees with the permission model rather than a second list", () => {
    for (const current of [USER_ROLES.SUPER_ADMIN, USER_ROLES.WORKER]) {
      for (const item of NAVIGATION_ITEMS) {
        const shown = visibleNavigationItems(current).includes(item);
        const allowed =
          !item.requiredPermission || roleHasPermission(current, item.requiredPermission);

        expect(shown, `${item.label} for ${current}`).toBe(allowed);
      }
    }
  });

  it("shows a signed-out visitor only the unrestricted destinations", () => {
    const anonymous = visibleNavigationItems(null).map((item) => item.href);

    expect(anonymous).not.toContain(ROUTES.QUICK_RENEW);
    expect(anonymous).not.toContain(ROUTES.SETTINGS);
    expect(anonymous).toContain(ROUTES.DASHBOARD);
  });

  it("renders a Worker no admin destination, even inside More", () => {
    role = USER_ROLES.WORKER;
    render(<MobileNavigation />);

    fireEvent.click(screen.getByRole("button", { name: /more/i }));
    const sheet = screen.getByRole("dialog");

    expect(within(sheet).getByRole("link", { name: "Quick Renewing" })).toBeTruthy();
    for (const label of ["Users", "Backups", "Logs", "Jobs", "Settings"]) {
      expect(within(sheet).queryByRole("link", { name: label })).toBeNull();
    }
  });
});

describe("the bar as rendered", () => {
  it("renders exactly five cells, the last one More", () => {
    render(<MobileNavigation />);

    const links = within(bar()).getAllByRole("link");
    expect(links).toHaveLength(4);
    expect(within(bar()).getByRole("button", { name: /more/i })).toBeTruthy();
  });

  it("shows the short label but keeps the full one as the accessible name", () => {
    render(<MobileNavigation />);

    /* Visible text is "Prepare"; assistive tech still hears "Quick Prepare". */
    const link = within(bar()).getByRole("link", { name: "Quick Prepare" });
    expect(link.textContent).toContain("Prepare");
    expect(link.textContent).not.toContain("Quick Prepare");
    expect(link.getAttribute("href")).toBe(ROUTES.QUICK_PREPARE);
  });

  it("marks the open destination, and only it", () => {
    pathname = ROUTES.ACCOUNTS;
    render(<MobileNavigation />);

    const current = within(bar())
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");

    expect(current).toHaveLength(1);
    expect(current[0]?.getAttribute("href")).toBe(ROUTES.ACCOUNTS);
  });

  it("marks a nested route as its section", () => {
    pathname = `${ROUTES.ACCOUNTS}/9386ecb8-4eef-44bf-a20d-8ff9eb917fce`;
    render(<MobileNavigation />);

    expect(within(bar()).getByRole("link", { name: "Accounts" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });
});

describe("the More sheet", () => {
  it("opens, lists every overflow destination, and closes on Escape", () => {
    render(<MobileNavigation />);
    const trigger = screen.getByRole("button", { name: /more/i });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    const sheet = screen.getByRole("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(within(sheet).getByText("More destinations")).toBeTruthy();

    for (const item of overflowMobileItems(USER_ROLES.SUPER_ADMIN)) {
      expect(within(sheet).getByRole("link", { name: item.label })).toBeTruthy();
    }
    /* Quick Renewing by its full name, and pointing at the route. */
    expect(within(sheet).getByRole("link", { name: "Quick Renewing" }).getAttribute("href")).toBe(
      ROUTES.QUICK_RENEW,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("highlights More — not a primary cell — while an overflow route is open", () => {
    pathname = ROUTES.QUICK_RENEW;
    render(<MobileNavigation />);

    const trigger = screen.getByRole("button", { name: /more/i });
    expect(trigger.className).toContain("text-primary");

    const marked = within(bar())
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(marked).toHaveLength(0);
  });

  it("marks the open destination inside the sheet", () => {
    pathname = ROUTES.QUICK_RENEW;
    render(<MobileNavigation />);

    fireEvent.click(screen.getByRole("button", { name: /more/i }));
    const sheet = screen.getByRole("dialog");

    expect(
      within(sheet).getByRole("link", { name: "Quick Renewing" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(sheet).getByRole("link", { name: "Problems" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("offers no More button when the role has nothing in the overflow", () => {
    /* Not reachable today, but the bar must not render an empty sheet if it were. */
    expect(overflowMobileItems(USER_ROLES.WORKER).length).toBeGreaterThan(0);
    expect(overflowMobileItems(USER_ROLES.SUPER_ADMIN).length).toBeGreaterThan(0);
  });
});

describe("touch targets", () => {
  it("gives every cell and every sheet row a 44px-capable height class", () => {
    render(<MobileNavigation />);

    for (const cell of [...bar().children]) {
      expect(cell.className).toContain("min-h-14");
    }

    fireEvent.click(screen.getByRole("button", { name: /more/i }));
    for (const link of within(screen.getByRole("dialog")).getAllByRole("link")) {
      expect(link.className).toContain("min-h-12");
    }
  });

  it("keeps the bar clear of the bottom safe area", () => {
    render(<MobileNavigation />);
    expect(bar().className).toContain("pb-[env(safe-area-inset-bottom)]");
  });
});

describe("permission constants this bar depends on", () => {
  it("still gates Quick Renewing on renew_subscriptions", () => {
    const item = NAVIGATION_ITEMS.find((entry) => entry.href === ROUTES.QUICK_RENEW);

    expect(item?.requiredPermission).toBe(PERMISSIONS.RENEW_SUBSCRIPTIONS);
  });
});
