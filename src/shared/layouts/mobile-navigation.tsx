"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { MOBILE_NAVIGATION_ITEMS } from "@/config/navigation";
import { cn } from "@/utils/cn";
import { isRouteActive } from "./sidebar";

/**
 * Mobile bottom navigation.
 *
 * 04_UI_GUIDELINES.md: bottom navigation on mobile, minimum touch target 44x44.
 * The `min-h-14` and `flex-1` below are what guarantee that on every screen
 * width, rather than only on the one it was designed against.
 */
export function MobileNavigation() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main navigation"
      className="sticky bottom-0 z-30 flex shrink-0 border-t border-border glass lg:hidden"
    >
      {MOBILE_NAVIGATION_ITEMS.map((item) => {
        const isActive = isRouteActive(pathname, item.href);
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex min-h-14 flex-1 flex-col items-center justify-center gap-1 px-1 py-2 transition-colors",
              "focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none focus-visible:ring-inset",
              isActive ? "text-primary" : "text-foreground-subtle hover:text-foreground",
            )}
          >
            <Icon className="size-5" aria-hidden="true" />
            <span className="text-center text-[0.625rem] leading-tight">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
