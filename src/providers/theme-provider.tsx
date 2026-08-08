"use client";

import { MotionConfig } from "framer-motion";
import { useEffect } from "react";

import { DURATION, EASING } from "@/config/theme";

/**
 * Theme provider.
 *
 * 04_UI_GUIDELINES.md: Dark Theme only. No Light Theme. No Theme Switcher.
 *
 * There is therefore nothing to switch, and no `next-themes` dependency. What
 * this provider actually does is two things that would otherwise be repeated in
 * every component:
 *
 * 1. Marks the document as dark for third-party components that look for a
 *    `dark` class or `data-theme` attribute rather than reading our tokens.
 *
 * 2. Establishes the default motion contract. Every Framer Motion animation in
 *    the application inherits the 200ms standard transition, so no component
 *    needs to restate it, and `reducedMotion="user"` means an operating system
 *    preference for less motion is honoured everywhere at once.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("dark");
    root.dataset["theme"] = "dark";
  }, []);

  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ duration: DURATION.base, ease: EASING.standard }}
    >
      {children}
    </MotionConfig>
  );
}
