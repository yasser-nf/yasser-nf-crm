"use client";

import { LogOut, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

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
 * Search and notifications arrive as slots (M05). The shell owns where they
 * sit; their modules own what they do. They are composed by the authenticated
 * layout, a Server Component, because their modules' barrels are server code
 * that a client file in `shared` may not import.
 */
export function Topbar({ search, notifications }: { search: ReactNode; notifications: ReactNode }) {
  const { user } = useAuth();
  const logout = useLogout();
  const router = useRouter();

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border glass px-4 lg:px-6">
      {search}

      <div className="ml-auto flex items-center gap-2">
        <Button
          onClick={() => router.push(ROUTES.QUICK_PREPARE)}
          className="hidden gap-2 sm:inline-flex"
        >
          <Zap className="size-4" aria-hidden="true" />
          Quick Prepare
        </Button>

        {notifications}

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
