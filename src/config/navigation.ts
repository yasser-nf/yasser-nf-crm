import {
  ChartColumn,
  DatabaseBackup,
  LayoutDashboard,
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
    label: "Settings",
    href: ROUTES.SETTINGS,
    icon: Settings,
    requiredPermission: PERMISSIONS.ACCESS_SETTINGS,
  },
] as const;

/**
 * Items shown in the mobile bottom navigation.
 *
 * 04_UI_GUIDELINES.md requires bottom navigation on mobile. Ten items do not
 * fit; the five highest-frequency destinations do.
 */
export const MOBILE_NAVIGATION_ITEMS: readonly NavigationItem[] = NAVIGATION_ITEMS.filter((item) =>
  (
    [
      ROUTES.DASHBOARD,
      ROUTES.ACCOUNTS,
      ROUTES.QUICK_PREPARE,
      ROUTES.CUSTOMERS,
      ROUTES.PROBLEMS,
    ] as readonly string[]
  ).includes(item.href),
);
