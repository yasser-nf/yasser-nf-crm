"use client";

import { Ellipsis } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { overflowMobileItems, primaryMobileItems, type NavigationItem } from "@/config/navigation";
import { useAuth } from "@/providers/auth-provider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { NavigationProgress } from "@/shared/ui/navigation-progress";
import { cn } from "@/utils/cn";
import { isRouteActive } from "./sidebar";

/**
 * Mobile bottom navigation.
 *
 * 04_UI_GUIDELINES.md: bottom navigation on mobile, minimum touch target 44x44.
 * `min-h-14` and `flex-1` guarantee that at every width rather than only the
 * one it was designed against.
 *
 * Four destinations plus More, because six cells put "Quick Prepare" and
 * "Quick Replace" onto two lines at 375px while their neighbours stayed on one.
 * More opens a sheet holding every other destination this role may see — which
 * is also the only way Quick Renewing is reachable on a phone.
 */
export function MobileNavigation() {
  const pathname = usePathname();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [syncedPath, setSyncedPath] = useState(pathname);

  const role = user?.role ?? null;
  const primary = primaryMobileItems(role);
  const overflow = overflowMobileItems(role);

  /*
   * The route change closes the sheet, rather than the click handler.
   *
   * It covers every way the route can change — a destination tapped here, a
   * back gesture, a link elsewhere on the page — in one place, and it keeps the
   * anchor mounted while the router takes the click rather than unmounting it
   * in the same tick. A tap on the destination already open changes no
   * pathname, so that single case closes itself on the link below.
   *
   * Adjusted during render rather than in an effect: the same idiom the logs
   * filters use to follow a changing URL, and the one the React compiler's
   * lint asks for instead of setState-in-effect.
   */
  if (pathname !== syncedPath) {
    setSyncedPath(pathname);
    setOpen(false);
  }

  const overflowActive = overflow.some((item) => isRouteActive(pathname, item.href));

  return (
    <>
      <nav
        aria-label="Main navigation"
        className={cn(
          "sticky bottom-0 z-30 flex shrink-0 border-t border-border glass lg:hidden",
          /*
           * Keeps the row clear of a home indicator. Resolves to 0 until the
           * document opts into `viewportFit: "cover"`, so it is harmless now
           * and correct the moment that changes.
           */
          "pb-[env(safe-area-inset-bottom)]",
        )}
      >
        {primary.map((item) => (
          <MobileLink key={item.href} item={item} isActive={isRouteActive(pathname, item.href)} />
        ))}

        {overflow.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
            className={cn(
              "relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 px-1 py-2 transition-colors",
              "focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none focus-visible:ring-inset",
              overflowActive ? "text-primary" : "text-foreground-subtle hover:text-foreground",
            )}
          >
            <Ellipsis className="size-5" aria-hidden="true" />
            <span className="text-center text-[0.625rem] leading-tight">More</span>
          </button>
        ) : null}
      </nav>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className={cn(
            /* A bottom sheet: the dialog's own centring is overridden here. */
            "top-auto bottom-0 left-0 max-h-[75dvh] w-full max-w-none translate-x-0 translate-y-0",
            "gap-3 overflow-y-auto rounded-t-xl rounded-b-none border-x-0 border-b-0 p-4",
            "data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100",
            "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
            /* Clear of the bar and the home indicator beneath it. */
            "pb-[calc(1rem+env(safe-area-inset-bottom))] lg:hidden",
          )}
        >
          <DialogHeader className="text-left">
            <DialogTitle>More destinations</DialogTitle>
            <DialogDescription>Everywhere else you can go from here.</DialogDescription>
          </DialogHeader>

          <ul className="flex flex-col gap-1">
            {overflow.map((item) => {
              const isActive = isRouteActive(pathname, item.href);
              const Icon = item.icon;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={isActive ? () => setOpen(false) : undefined}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex min-h-12 items-center gap-3 rounded-md px-3 py-2 text-description transition-colors",
                      "focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none",
                      isActive
                        ? "bg-primary-subtle font-medium text-primary"
                        : "text-foreground-muted hover:bg-surface-raised hover:text-foreground",
                    )}
                  >
                    <Icon className="size-5 shrink-0" aria-hidden="true" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MobileLink({ item, isActive }: { item: NavigationItem; isActive: boolean }) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      /* The full name for assistive tech; the short one is only what fits. */
      aria-label={item.shortLabel ? item.label : undefined}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 px-1 py-2 transition-colors",
        "focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none focus-visible:ring-inset",
        isActive ? "text-primary" : "text-foreground-subtle hover:text-foreground",
      )}
    >
      <Icon className="size-5" aria-hidden="true" />
      <span className="text-center text-[0.625rem] leading-tight">
        {item.shortLabel ?? item.label}
      </span>

      <NavigationProgress />
    </Link>
  );
}
