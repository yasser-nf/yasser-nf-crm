/**
 * Design system constants.
 *
 * The visual source of truth is `src/app/globals.css`. This file mirrors the
 * parts of it that JavaScript genuinely needs — animation timing for Framer
 * Motion, and the spacing scale that 04_UI_GUIDELINES.md constrains.
 *
 * Colors are deliberately NOT duplicated here. A colour defined in two places
 * drifts. Read colours through Tailwind classes only.
 */

/**
 * 04_UI_GUIDELINES.md: "Use only 4 8 12 16 20 24 32 40 48 64.
 * Never invent spacing values."
 *
 * These are the Tailwind steps that produce those pixel values. Layout spacing
 * must use one of these; anything else is a design system violation.
 */
export const SPACING_SCALE = {
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "20px",
  6: "24px",
  8: "32px",
  10: "40px",
  12: "48px",
  16: "64px",
} as const;

export type SpacingStep = keyof typeof SPACING_SCALE;

/** Border radius. Small 8 · Medium 12 · Large 16 · Dialogs 24. */
export const RADIUS = {
  sm: "0.5rem",
  md: "0.75rem",
  lg: "1rem",
  dialog: "1.5rem",
} as const;

/**
 * Motion durations in seconds, for Framer Motion.
 *
 * 04_UI_GUIDELINES.md: "Never exceed 300ms." These three values are the only
 * durations permitted in the application.
 */
export const DURATION = {
  fast: 0.15,
  base: 0.2,
  slow: 0.25,
} as const;

export const EASING = {
  standard: [0.4, 0, 0.2, 1],
  out: [0.16, 1, 0.3, 1],
} as const;

/** Shared Framer Motion transition presets. */
export const TRANSITION = {
  fast: { duration: DURATION.fast, ease: EASING.standard },
  base: { duration: DURATION.base, ease: EASING.standard },
  slow: { duration: DURATION.slow, ease: EASING.out },
} as const;

/**
 * Toast configuration.
 * 04_UI_GUIDELINES.md: Position top right. Duration 3–5 seconds.
 */
export const TOAST = {
  position: "top-right",
  duration: 4000,
} as const;

/** 04_UI_GUIDELINES.md: minimum touch target 44x44 on mobile. */
export const MIN_TOUCH_TARGET_PX = 44;
