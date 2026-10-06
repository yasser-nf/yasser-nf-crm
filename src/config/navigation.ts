import {
  Building2,
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

import { PERMISSIONS, type Permission } from "@/config/roles";
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
  { label: "Quick Prepare", href: ROUTES.QUICK_PREPARE, icon: Zap },
  { label: "Quick Replace", href: ROUTES.QUICK_REPLACE, icon: RefreshCcw },
  {
    label: "Quick Renew",
    href: ROUTES.QUICK_RENEW,
    icon: CalendarPlus,
    /*
     * M09. Hidden from a role that cannot renew — and hiding is only the
     * courtesy: `quickRenewService` refuses both the lookup and the commit
     * without this permission, because a Server Action is a POST endpoint
     * anybody holding a session can call directly.
     */
    requiredPermission: PERMISSIONS.RENEW_SUBSCRIPTIONS,
  },
  {
    label: "Suppliers",
    href: ROUTES.SUPPLIERS,
    icon: Building2,
    /*
     * M10 §19 and §20. A Worker sees suppliers; only a Super Admin may change
     * one, which the page and the service decide separately — hiding the item
     * from a role without even view access is the courtesy, not the control.
     */
    requiredPermission: PERMISSIONS.VIEW_SUPPLIERS,
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
 * Items shown in the mobile bottom navigation.
 *
 * 04_UI_GUIDELINES.md requires bottom navigation on mobile. Eleven items do not
 * fit; the six highest-frequency destinations do.
 *
 * Quick Replace belongs here despite the crowding. On mobile the sidebar is
 * hidden entirely, so an operator standing in front of a customer had no way to
 * reach /quick-replace at all — the route worked, but only if typed by hand.
 * Six is the ceiling: at 375px each item still gets 62px, comfortably past the
 * 44px minimum touch target.
 *
 * M09 takes the sixth slot for Quick Renew rather than making it a seventh.
 * The same argument that put Quick Replace here applies — a renewal is done
 * with the customer on the phone — and Problems yields the slot because it is a
 * review screen rather than something done while standing in front of someone.
 * Problems stays reachable from the sidebar on desktop, from the notification
 * bell, and from every account that has one.
 */
export const MOBILE_NAVIGATION_ITEMS: readonly NavigationItem[] = NAVIGATION_ITEMS.filter((item) =>
  (
    [
      ROUTES.DASHBOARD,
      ROUTES.ACCOUNTS,
      ROUTES.QUICK_PREPARE,
      ROUTES.QUICK_REPLACE,
      ROUTES.QUICK_RENEW,
      ROUTES.CUSTOMERS,
    ] as readonly string[]
  ).includes(item.href),
);
