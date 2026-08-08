"use client";

import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { Toaster as SonnerToaster, type ToasterProps } from "sonner";

import { TOAST } from "@/config/theme";

/**
 * Toast host.
 *
 * Two deliberate departures from the shadcn default:
 *
 * 1. The generated version reads the active theme from `next-themes`. This
 *    application has one theme by design — 04_UI_GUIDELINES.md forbids a light
 *    theme and a switcher — so the dependency would exist only to report a
 *    constant. The theme is stated directly instead.
 *
 * 2. The generated icons (Loader2Icon, OctagonXIcon) were removed in lucide v1.
 *
 * Position and duration come from config/theme.ts so they cannot drift from the
 * design system.
 */
export function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      theme="dark"
      position={TOAST.position}
      duration={TOAST.duration}
      // 04_UI_GUIDELINES.md: maximum one stack.
      visibleToasts={3}
      closeButton
      className="toaster group"
      icons={{
        success: <CircleCheck className="size-4 text-success" />,
        info: <Info className="size-4 text-primary" />,
        warning: <TriangleAlert className="size-4 text-warning" />,
        error: <CircleAlert className="size-4 text-danger" />,
        loading: <LoaderCircle className="size-4 animate-spin text-foreground-muted" />,
      }}
      style={
        {
          "--normal-bg": "var(--color-surface-overlay)",
          "--normal-text": "var(--color-foreground)",
          "--normal-border": "var(--color-border-strong)",
          "--border-radius": "var(--radius-md)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}
