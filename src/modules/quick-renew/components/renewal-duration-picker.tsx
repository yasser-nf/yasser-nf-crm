"use client";

import { cn } from "@/utils/cn";
import { Label } from "@/shared/ui/label";
import { RENEWAL_PRESETS, type RenewalDuration } from "../services/renewal-duration";

/**
 * How long to renew for. M09 §8.
 *
 * Five presets and a custom day count. The presets are read from
 * `RENEWAL_PRESETS` rather than listed here, so the screen and the server's
 * validation enum cannot offer different lengths.
 *
 * Nothing here computes a date. The new expiry comes from the server's quote,
 * which is the same `quoteRenewal` the commit uses — a second implementation in
 * React would be a second source of truth, and this flow's whole claim is that
 * the date on screen is the date written.
 *
 * The custom bound below mirrors the server's `MAX_DURATION_DAYS`. It cannot be
 * imported: the schema that owns it reaches the quick-prepare barrel, which
 * re-exports `server-only` services, and pulling that into a Client Component
 * is a build error — the same constraint `QuickPrepareWizard` and
 * `QuickReplaceScreen` already declare their own form rules under. The server
 * validates again on every quote and every commit and its refusal renders on
 * this input, so this copy saves a round trip rather than being the check that
 * matters.
 */

/** Two years, as `MAX_DURATION_DAYS` has always been. */
const MAX_CUSTOM_DAYS = 730;

export interface RenewalDurationPickerProps {
  readonly value: RenewalDuration | null;
  readonly onChange: (duration: RenewalDuration | null) => void;
  /** The raw text in the custom box, owned by the parent so it survives a quote. */
  readonly customText: string;
  readonly onCustomTextChange: (text: string) => void;
  readonly disabled: boolean;
  /** A refusal from the server, or from the check below. */
  readonly error?: string | undefined;
}

/**
 * What the typed text means, in the one place that decides it.
 *
 * Returns null for anything that is not a renewal, which the caller renders as
 * a message rather than quoting. The rejections are M09 §8's list: empty,
 * zero, negative, decimal, non-numeric, absurd.
 */
export function parseCustomDays(text: string): { days: number } | { error: string } | null {
  const trimmed = text.trim();

  if (trimmed === "") {
    return null;
  }

  /*
   * A whole number of days, and nothing else. `Number()` alone would accept
   * "30.0", "1e3", " 30 " and hexadecimal; the pattern refuses all of them
   * before the value is ever looked at, so "30.5" reads as a decimal rather
   * than silently becoming 30.
   */
  if (!/^\d+$/.test(trimmed)) {
    return { error: "Enter a whole number of days" };
  }

  const days = Number(trimmed);

  if (days < 1) {
    return { error: "Renew for at least one day" };
  }

  if (days > MAX_CUSTOM_DAYS) {
    return { error: "A renewal cannot exceed two years" };
  }

  return { days };
}

export function RenewalDurationPicker({
  value,
  onChange,
  customText,
  onCustomTextChange,
  disabled,
  error,
}: RenewalDurationPickerProps) {
  function chooseCustom(text: string) {
    onCustomTextChange(text);

    const parsed = parseCustomDays(text);

    /*
     * An unusable value clears the selection rather than keeping the last good
     * one. Leaving a stale duration selected while the box reads something else
     * is how an operator confirms a renewal they are no longer looking at.
     */
    onChange(parsed !== null && "days" in parsed ? { kind: "custom", days: parsed.days } : null);
  }

  const customError =
    error ??
    (() => {
      const parsed = parseCustomDays(customText);
      return parsed !== null && "error" in parsed ? parsed.error : undefined;
    })();

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-card-title text-foreground">Renew for</h2>
        <p className="text-caption text-foreground-muted">
          A month is a calendar month — 20 October plus three months is 20 January.
        </p>
      </header>

      <div
        role="group"
        aria-label="Renewal length"
        className="grid grid-cols-2 gap-2 sm:grid-cols-5"
      >
        {RENEWAL_PRESETS.map((preset) => {
          const selected = value?.kind === "preset" && value.preset === preset.id;

          return (
            <button
              key={preset.id}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => {
                /* Choosing a preset clears the custom box, so only one answer is live. */
                onCustomTextChange("");
                onChange({ kind: "preset", preset: preset.id });
              }}
              className={cn(
                "min-h-11 rounded-md border px-3 py-2 text-caption font-medium transition-colors",
                "disabled:cursor-not-allowed disabled:opacity-60",
                selected
                  ? "border-primary bg-primary-subtle text-primary"
                  : "border-border bg-background-secondary text-foreground hover:border-primary/40",
              )}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <Label
          htmlFor="renewal-custom-days"
          className="text-description font-medium text-foreground"
        >
          Or a custom number of days
        </Label>

        <input
          id="renewal-custom-days"
          /*
           * `inputMode` rather than `type="number"`: a number input lets a
           * scroll wheel change a committed-to value by accident, and accepts
           * "30e2" in some browsers. The text is parsed by `parseCustomDays`.
           */
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="e.g. 45"
          value={customText}
          disabled={disabled}
          aria-invalid={Boolean(customError)}
          aria-describedby={customError ? "renewal-custom-days-error" : undefined}
          onChange={(event) => chooseCustom(event.target.value)}
          className={cn(
            "h-11 w-full rounded-md border bg-background-secondary px-3 text-foreground tabular-nums",
            "placeholder:text-foreground-subtle focus-visible:ring-2 focus-visible:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-60",
            customError
              ? "border-danger focus-visible:ring-danger/30"
              : "border-border focus-visible:border-primary focus-visible:ring-primary/30",
          )}
        />

        {customError ? (
          <p id="renewal-custom-days-error" role="alert" className="text-caption text-danger">
            {customError}
          </p>
        ) : (
          <p className="text-caption text-foreground-subtle">
            Whole days, from 1 to {MAX_CUSTOM_DAYS}.
          </p>
        )}
      </div>
    </section>
  );
}

export { MAX_CUSTOM_DAYS };
