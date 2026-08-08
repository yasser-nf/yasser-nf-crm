"use client";

import { useRouter } from "next/navigation";
import { createContext, use, useEffect, useMemo, useState } from "react";

import { toAppUser, type AppUser } from "@/lib/auth";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Authentication provider.
 *
 * The initial user is resolved on the server and passed in, so the first paint
 * already knows who is signed in. There is no authenticated-but-still-loading
 * flicker, and no client-side fetch on every page load.
 *
 * After hydration this subscribes to Supabase auth events so that a session
 * ending in one browser tab is reflected in the others.
 */

interface AuthContextValue {
  readonly user: AppUser | null;
  readonly isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  initialUser,
}: {
  children: React.ReactNode;
  initialUser: AppUser | null;
}) {
  const [user, setUser] = useState<AppUser | null>(initialUser);
  const router = useRouter();

  /*
   * Server-rendered navigations can deliver a different user than the one held
   * in state — after signing out and back in, for example.
   *
   * Adjusted during render rather than in an effect. An effect would render the
   * stale user first and correct it immediately afterwards, which is both a
   * wasted pass and a visible flicker of the previous person's name. Identity is
   * compared by value because the server sends a fresh object every render.
   */
  const initialUserKey = initialUser ? `${initialUser.id}:${initialUser.email}` : null;
  const [syncedUserKey, setSyncedUserKey] = useState(initialUserKey);

  if (initialUserKey !== syncedUserKey) {
    setSyncedUserKey(initialUserKey);
    setUser(initialUser);
  }

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(toAppUser(session?.user ?? null));

      /*
       * Server Components hold the authoritative view of the session. Refreshing
       * lets middleware re-run and redirect, rather than leaving a signed-out
       * user looking at a page they can no longer load data for.
       */
      if (event === "SIGNED_OUT" || event === "SIGNED_IN") {
        router.refresh();
      }
    });

    return () => subscription.unsubscribe();
  }, [router]);

  const value = useMemo<AuthContextValue>(() => ({ user, isAuthenticated: user !== null }), [user]);

  return <AuthContext value={value}>{children}</AuthContext>;
}

/**
 * Reads the current user.
 *
 * Throws when used outside the provider, because that is a programmer error
 * rather than a runtime condition worth modelling as a Result.
 */
export function useAuth(): AuthContextValue {
  const context = use(AuthContext);

  if (context === null) {
    throw new Error("useAuth must be used within AuthProvider.");
  }

  return context;
}
