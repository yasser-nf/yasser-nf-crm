import {
  PROFILE_STATE_LABELS,
  PROFILE_STATE_STYLES,
  ProfileStateLegend,
} from "@/shared/ui/profile-state";
import type { ProfileIndicator } from "../services/accounts.service";
import { cn } from "@/utils/cn";

/**
 * The five profile cells on an account row.
 *
 * A Server Component: it renders state it is given and computes nothing. Every
 * `state` value was decided by `profileCellState` in the domain layer, which is
 * the same function the account detail page and Quick Prepare go through — M13
 * §7 requires one interpretation, and this component is deliberately too dumb
 * to hold a second one.
 *
 * It never receives a password, a PIN or a customer identity, so it cannot leak
 * one.
 *
 * The four colours and their labels live in `@/shared/ui/profile-state`, shared
 * with Quick Replace's slot grid. They were defined here until Quick Replace
 * needed the same vocabulary from a Client Component, which cannot import this
 * module's barrel.
 */

function describe(indicator: ProfileIndicator): string {
  const base = `Profile ${indicator.profileNumber}: ${PROFILE_STATE_LABELS[indicator.state]}`;

  if (
    (indicator.state === "sold" || indicator.state === "expiring_soon") &&
    indicator.expirationDate
  ) {
    return `${base}, expires ${indicator.expirationDate}`;
  }

  if (indicator.state === "expired" && indicator.expirationDate) {
    return `${base}, expired ${indicator.expirationDate}`;
  }

  return base;
}

export function ProfileIndicators({
  indicators,
  className,
}: {
  indicators: readonly ProfileIndicator[];
  className?: string;
}) {
  if (indicators.length === 0) {
    return <span className="text-caption text-foreground-subtle">—</span>;
  }

  return (
    <ul className={cn("flex items-center gap-1", className)}>
      {indicators.map((indicator) => (
        <li key={indicator.profileId}>
          <span
            /*
             * title carries the same text as the accessible label, so a mouse
             * user and a screen-reader user learn the same thing.
             */
            title={describe(indicator)}
            aria-label={describe(indicator)}
            className={cn(
              "flex size-7 items-center justify-center rounded border text-caption font-medium tabular-nums",
              PROFILE_STATE_STYLES[indicator.state],
            )}
          >
            {indicator.profileNumber}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The legend, so four colours do not have to be guessed.
 *
 * Kept as a named export because the accounts barrel, the accounts table and the
 * detail page all reference it. The rendering itself is the shared one.
 */
export function ProfileIndicatorLegend({ className }: { className?: string }) {
  return <ProfileStateLegend {...(className === undefined ? {} : { className })} />;
}
