import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merges Tailwind class names, resolving conflicts in favour of the last value.
 *
 * ADR-002: this lives in utils/ rather than the shadcn default lib/utils.ts,
 * because 02_ARCHITECTURE.md reserves lib/ for infrastructure and defines utils/
 * as pure helper functions. This is a pure function.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
