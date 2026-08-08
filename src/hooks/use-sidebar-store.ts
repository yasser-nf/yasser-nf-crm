"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { STORAGE_KEYS } from "@/config/constants";

/**
 * Sidebar state.
 *
 * 02_ARCHITECTURE.md: global state uses Zustand, server state uses TanStack
 * Query. Whether the sidebar is collapsed is a user interface preference that
 * never touches the server, so it belongs here.
 *
 * Persisted, because re-collapsing the sidebar on every page load is the kind
 * of small daily friction that makes an internal tool feel unfinished.
 */

interface SidebarState {
  readonly isCollapsed: boolean;
  readonly isMobileOpen: boolean;
  toggleCollapsed: () => void;
  setMobileOpen: (open: boolean) => void;
}

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      isCollapsed: false,
      isMobileOpen: false,
      toggleCollapsed: () => set((state) => ({ isCollapsed: !state.isCollapsed })),
      setMobileOpen: (open) => set({ isMobileOpen: open }),
    }),
    {
      name: STORAGE_KEYS.SIDEBAR,
      /*
       * Only the collapse preference is persisted. Restoring an open mobile
       * drawer on load would mean the app opens with a menu covering it.
       */
      partialize: (state) => ({ isCollapsed: state.isCollapsed }),
    },
  ),
);
