import {
  CalendarPlus,
  ChartColumn,
  DatabaseBackup,
  LayoutDashboard,
  ListChecks,
  RefreshCcw,
  ScrollText,
  Settings,
  TriangleAlert,
  Tv,
  UserCog,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { PERMISSIONS, roleHasPermission, type Permission, type UserRole } from "@/config/roles";
import { ROUTES } from "@/config/constants";

/**
 * Application navigation.
 *
 * 02_ARCHITECTURE.md v1.1: the Sidebar is the canonical navigation and the
 * route list matches it exactly. Navigation is declared once, here. Never
 * hardcode navigation items inside components.
 */

export interface NavigationItem {
  readonly label: string;
  /**
   * A shorter label for the mobile bottom bar, where a cell is 67px of text at
   * 375px and 56px at 320px. "Quick Prepare" needs 67.1px — it misses by a
   * tenth of a pixel and wraps onto a second line while its neighbours stay on
   * one, which is the uneven row this exists to avoid.
   *
   * Display only. The sidebar, the More menu and the link's accessible name all
   * keep the full label, so the short form is never the only thing naming a
   * destination (and WCAG 2.5.3 holds: "Quick Prepare" contains "Prepare").
   */
  readonly shortLabel?: string;
  readonly href: string;
  readonly icon: LucideIcon;
  /**
   * Capability required to see this item.
   *
   * ADR-003: role storage is deferred until 03_DATABASE.md exists, so nothing
   * reads this yet. It is declared now because it is navigation data, not
   * behaviour — adding it later would mean editing every entry.
   */
  readonly requiredPermission?: Permission;
}

export const NAVIGATION_ITEMS: readonly NavigationItem[] = [
  { label: "Dashboard", href: ROUTES.DASHBOARD, icon: LayoutDashboard },
  { label: "Accounts", href: ROUTES.ACCOUNTS, icon: Tv },
  { label: "Quick Prepare", shortLabel: "Prepare", href: ROUTES.QUICK_PREPARE, icon: Zap },
  { label: "Quick Replace", shortLabel: "Replace", href: ROUTES.QUICK_REPLACE, icon: RefreshCcw },
  {
    label: "Quick Renewing",
    shortLabel: "Renew",
    href: ROUTES.QUICK_RENEW,
    icon: CalendarPlus,
    requiredPermission: PERMISSIONS.RENEW_SUBSCRIPTIONS,
  },
  { label: "Customers", href: ROUTES.CUSTOMERS, icon: Users },
  { label: "Problems", href: ROUTES.PROBLEMS, icon: TriangleAlert },
  {
    label: "Users",
    href: ROUTES.USERS,
    icon: UserCog,
    requiredPermission: PERMISSIONS.MANAGE_USERS,
  },
  { label: "Reports", href: ROUTES.REPORTS, icon: ChartColumn },
  {
    label: "Backups",
    href: ROUTES.BACKUPS,
    icon: DatabaseBackup,
    requiredPermission: PERMISSIONS.ACCESS_BACKUPS,
  },
  {
    label: "Logs",
    href: ROUTES.LOGS,
    icon: ScrollText,
    requiredPermission: PERMISSIONS.VIEW_LOGS,
  },
  {
    label: "Jobs",
    href: ROUTES.JOBS,
    icon: ListChecks,
    requiredPermission: PERMISSIONS.VIEW_JOBS,
  },
  {
    label: "Settings",
    href: ROUTES.SETTINGS,
    icon: Settings,
    requiredPermission: PERMISSIONS.ACCESS_SETTINGS,
  },
] as const;

/**
 * Whether a role may see a navigation item.
 *
 * `requiredPermission` was declared from the first milestone and, until the
 * mobile More menu, read by nothing — both navigations rendered every item to
 * everyone. Harmless while every page re-checks on the server (they all do, and
 * a Worker who followed such a link got a refusal), but the More menu would
 * have listed Backups, Logs, Jobs and Settings to a Worker in one place, which
 * is a worse thing to show than a sidebar entry.
 *
 * The sidebar is deliberately NOT changed here — that is desktop behaviour
 * outside this fix's scope — so for now the two disagree, and the sidebar's
 * gap is reported rather than silently altered.
 */
export function canSeeNavigationItem(item: NavigationItem, role: UserRole | null): boolean {
  if (!item.requiredPermission) {
    return true;
  }

  return role !== null && roleHasPermission(role, item.requiredPermission);
}

/** Every destination this role may see, in sidebar order. */
export function visibleNavigationItems(role: UserRole | null): readonly NavigationItem[] {
  return NAVIGATION_ITEMS.filter((item) => canSeeNavigationItem(item, role));
}

/**
 * The destinations that get their own cell in the mobile bottom bar.
 *
 * FOUR, not six. 04_UI_GUIDELINES.md requires bottom navigation on mobile and a
 * 44px minimum touch target, and six cells met that — but at 375px each cell is
 * 62.5px, and "Quick Prepare" and "Quick Replace" wrap onto a second line while
 * their neighbours stay on one, which is the label collision this fixes. Four
 * cells plus More gives 75px at 375px and 64px at 320px, where every label fits
 * on one line.
 *
 * Everything else — including Quick Renewing, which had no mobile entry at all
 * when it shipped — is reachable through More, so no destination is lost.
 */
const PRIMARY_MOBILE_ROUTES: readonly string[] = [
  ROUTES.DASHBOARD,
  ROUTES.ACCOUNTS,
  ROUTES.QUICK_PREPARE,
  ROUTES.CUSTOMERS,
];

/** The bar's own cells, for this role. */
export function primaryMobileItems(role: UserRole | null): readonly NavigationItem[] {
  return visibleNavigationItems(role).filter((item) => PRIMARY_MOBILE_ROUTES.includes(item.href));
}

/** Everything the bar does not show, for this role — the More menu's contents. */
export function overflowMobileItems(role: UserRole | null): readonly NavigationItem[] {
  return visibleNavigationItems(role).filter((item) => !PRIMARY_MOBILE_ROUTES.includes(item.href));
}
