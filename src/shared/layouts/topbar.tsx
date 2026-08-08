"use client";

import { Bell, LogOut, Search, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";

import { ROUTES } from "@/config/constants";
import { useLogout } from "@/modules/auth";
import { useAuth } from "@/providers/auth-provider";
import { Avatar, AvatarFallback } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

/**
 * Top navigation.
 *
 * 04_UI_GUIDELINES.md: search, notifications, Quick Prepare, profile menu.
 * Never overcrowd the topbar — those four, and nothing else.
 *
 * Search and notifications are rendered here because the shell owns their
 * placement, but their behaviour belongs to the milestones that build them.
 * They are disabled rather than wired to nothing, so the interface never
 * promises an action it cannot perform.
 */
export function Topbar() {
  const { user } = useAuth();
  const logout = useLogout();
  const router = useRouter();

  /*
   * 04_UI_GUIDELINES.md: global search is always accessible via CTRL+K. The
   * shortcut is registered by the shell so it works on every page; the search
   * experience itself belongs to its own milestone.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toast.info("Global search arrives in a later milestone.");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border glass px-4 lg:px-6">
      <Button
        variant="outline"
        onClick={() => toast.info("Global search arrives in a later milestone.")}
        className="h-9 max-w-sm flex-1 justify-start gap-2 border-border bg-background-secondary px-3 text-foreground-subtle hover:text-foreground"
      >
        <Search className="size-4" aria-hidden="true" />
        <span className="truncate text-description">Search</span>
        <kbd className="ml-auto hidden items-center gap-0.5 rounded border border-border px-1.5 py-0.5 font-mono text-caption text-foreground-subtle sm:inline-flex">
          Ctrl K
        </kbd>
      </Button>

      <div className="ml-auto flex items-center gap-2">
        <Button
          onClick={() => router.push(ROUTES.QUICK_PREPARE)}
          className="hidden gap-2 sm:inline-flex"
        >
          <Zap className="size-4" aria-hidden="true" />
          Quick Prepare
        </Button>

        <Button
          variant="ghost"
          size="icon"
          aria-label="Notifications"
          onClick={() => toast.info("Notifications arrive in a later milestone.")}
          className="text-foreground-muted hover:text-foreground"
        >
          <Bell aria-hidden="true" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Account menu" className="rounded-full">
              <Avatar className="size-8">
                <AvatarFallback className="bg-primary-subtle text-caption font-medium text-primary">
                  {user?.initials ?? "?"}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="text-card-title text-foreground">
                {user?.displayName ?? "Signed in"}
              </span>
              <span className="truncate text-caption font-normal text-foreground-subtle">
                {user?.email}
              </span>
            </DropdownMenuLabel>

            <DropdownMenuSeparator />

            <DropdownMenuItem
              disabled={logout.isPending}
              onSelect={(event) => {
                // Keep the menu mounted while the request is in flight.
                event.preventDefault();
                logout.mutate();
              }}
              className="text-danger focus:bg-danger-subtle focus:text-danger"
            >
              <LogOut className="size-4" aria-hidden="true" />
              {logout.isPending ? "Signing out…" : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
