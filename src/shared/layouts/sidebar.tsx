"use client";

import { motion } from "framer-motion";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";

import { NavigationProgress } from "@/shared/ui/navigation-progress";
import { usePathname } from "next/navigation";

import { APP_NAME, ROUTES } from "@/config/constants";
import { NAVIGATION_ITEMS, type NavigationItem } from "@/config/navigation";
import { DURATION, EASING } from "@/config/theme";
import { useSidebarStore } from "@/hooks/use-sidebar-store";
import { Button } from "@/shared/ui/button";
import { cn } from "@/utils/cn";

/**
 * Desktop sidebar.
 *
 * 04_UI_GUIDELINES.md: fixed, collapsible, always visible on desktop.
 *
 * Navigation comes from config/navigation.ts. Nothing in this file knows what
 * the destinations are, which is what lets a route be added without touching a
 * component.
 */

/** True when the item is the current page or an ancestor of it. */
export function isRouteActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarLink({ item, isCollapsed }: { item: NavigationItem; isCollapsed: boolean }) {
  const pathname = usePathname();
  const isActive = isRouteActive(pathname, item.href);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      aria-current={isActive ? "page" : undefined}
      title={isCollapsed ? item.label : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-md px-3 py-2 text-description transition-colors",
        "focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none",
        isActive
          ? "bg-primary-subtle font-medium text-primary"
          : "text-foreground-muted hover:bg-surface-raised hover:text-foreground",
        isCollapsed && "justify-center px-0",
      )}
    >
      {isActive ? (
        <motion.span
          layoutId="sidebar-active-indicator"
          transition={{ duration: DURATION.base, ease: EASING.standard }}
          className="absolute left-0 h-5 w-0.5 rounded-full bg-primary"
          aria-hidden="true"
        />
      ) : null}

      <Icon className="size-4 shrink-0" aria-hidden="true" />

      {!isCollapsed ? <span className="truncate">{item.label}</span> : null}

      <NavigationProgress />
    </Link>
  );
}

export function Sidebar() {
  const isCollapsed = useSidebarStore((state) => state.isCollapsed);
  const toggleCollapsed = useSidebarStore((state) => state.toggleCollapsed);

  return (
    <aside
      aria-label="Main navigation"
      className={cn(
        "hidden shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 lg:flex",
        isCollapsed ? "w-16" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-16 items-center border-b border-border px-4",
          isCollapsed ? "justify-center" : "justify-between",
        )}
      >
        {!isCollapsed ? (
          <Link
            href={ROUTES.DASHBOARD}
            className="truncate text-card-title font-bold text-foreground"
          >
            {APP_NAME}
          </Link>
        ) : null}

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleCollapsed}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!isCollapsed}
          className="text-foreground-subtle hover:text-foreground"
        >
          {isCollapsed ? (
            <PanelLeftOpen aria-hidden="true" />
          ) : (
            <PanelLeftClose aria-hidden="true" />
          )}
        </Button>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        {NAVIGATION_ITEMS.map((item) => (
          <SidebarLink key={item.href} item={item} isCollapsed={isCollapsed} />
        ))}
      </nav>
    </aside>
  );
}
