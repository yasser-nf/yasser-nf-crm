"use client";

import type { AppUser } from "@/lib/auth";
import { Toaster } from "@/shared/ui/sonner";
import { AuthProvider } from "./auth-provider";
import { QueryProvider } from "./query-provider";
import { ThemeProvider } from "./theme-provider";

/**
 * Composes every application provider in one place.
 *
 * Order matters. Theme is outermost so motion defaults apply to everything
 * inside it. Query wraps Auth because auth-driven data fetching lives inside
 * the query cache.
 */
export function AppProviders({
  children,
  initialUser,
}: {
  children: React.ReactNode;
  initialUser: AppUser | null;
}) {
  return (
    <ThemeProvider>
      <QueryProvider>
        <AuthProvider initialUser={initialUser}>
          {children}
          <Toaster />
        </AuthProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}
