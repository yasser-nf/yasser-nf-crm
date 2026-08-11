import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";

import { cn } from "@/utils/cn";

/**
 * Dashboard building blocks.
 *
 * Every widget on this page is a Card with the same header, the same spacing
 * and the same empty state. 04_UI_GUIDELINES.md: no component should look
 * different from the design system, and a dashboard is where inconsistency
 * shows up fastest because a dozen widgets sit side by side.
 *
 * Server components — none of these hold state, so none of them need to ship
 * JavaScript.
 */

export function Widget({
  title,
  description,
  icon: Icon,
  action,
  className,
  children,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-4 rounded-lg border border-border bg-surface p-5",
        className,
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          {Icon ? (
            <Icon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
          ) : null}
          <div className="flex flex-col gap-0.5">
            <h2 className="text-card-title text-foreground">{title}</h2>
            {description ? (
              <p className="text-caption text-foreground-subtle">{description}</p>
            ) : null}
          </div>
        </div>
        {action}
      </header>

      {children}
    </section>
  );
}

/**
 * What a widget shows when it has nothing to show.
 *
 * Distinct from an error: "no data yet" is a normal state for a CRM that has
 * not been filled in, and dressing it as a failure would send someone hunting
 * for a bug that is not there.
 */
export function WidgetEmpty({
  message,
  icon: Icon = Inbox,
}: {
  message: string;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border px-4 py-8 text-center">
      <Icon className="size-5 text-foreground-subtle" aria-hidden="true" />
      <p className="text-caption text-foreground-muted">{message}</p>
    </div>
  );
}

/** Shown when a read failed, as opposed to returning nothing. */
export function WidgetError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-danger/30 bg-danger-subtle px-4 py-3 text-caption text-danger"
    >
      {message}
    </div>
  );
}

/** Shown when the viewer's role excludes this widget entirely. */
export function WidgetForbidden() {
  return (
    <div className="rounded-md bg-background-secondary px-4 py-3 text-caption text-foreground-muted">
      Not available to your role.
    </div>
  );
}

export function Metric({
  label,
  value,
  tone = "default",
  hint,
}: {
  label: string;
  value: number | string;
  tone?: "default" | "success" | "warning" | "danger" | "muted";
  hint?: string;
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "danger"
          ? "text-danger"
          : tone === "muted"
            ? "text-foreground-subtle"
            : "text-foreground";

  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-foreground-subtle">{label}</span>
      <span className={cn("text-section-title tabular-nums", toneClass)}>{value}</span>
      {hint ? <span className="text-caption text-foreground-subtle">{hint}</span> : null}
    </div>
  );
}

export function MetricGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{children}</div>;
}

/**
 * A sparkline-style bar chart, drawn as inline SVG.
 *
 * No charting library. 01_MASTER_RULES.md prefers native APIs and warns against
 * unnecessary packages; a bar chart is a handful of rectangles, and pulling in
 * a rendering library for it would add bundle weight and a client component
 * where a server-rendered SVG does the job.
 *
 * Renders nothing when every value is zero — the caller shows an empty state
 * instead, because a flat line at zero looks like a broken chart rather than an
 * empty one.
 */
export function BarChart({
  points,
  label,
}: {
  points: readonly { day: string; count: number }[];
  label: string;
}) {
  const max = Math.max(...points.map((point) => point.count), 0);

  if (points.length === 0 || max === 0) {
    return <WidgetEmpty message="No activity in this period yet." />;
  }

  const width = 100;
  const height = 32;
  const gap = 0.6;
  const barWidth = Math.max(width / points.length - gap, 0.5);

  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-20 w-full"
        role="img"
        aria-label={`${label}. Highest value ${max}.`}
      >
        {points.map((point, index) => {
          /* Minimum 1 unit so a day with one row is visible rather than invisible. */
          const barHeight = Math.max((point.count / max) * height, point.count > 0 ? 1 : 0);

          return (
            <rect
              key={point.day}
              x={index * (barWidth + gap)}
              y={height - barHeight}
              width={barWidth}
              height={barHeight}
              rx={0.5}
              className="fill-primary/70"
            />
          );
        })}
      </svg>
      <figcaption className="flex justify-between text-caption text-foreground-subtle">
        <span>{points[0]?.day}</span>
        <span>peak {max}</span>
        <span>{points[points.length - 1]?.day}</span>
      </figcaption>
    </figure>
  );
}

/** A horizontal breakdown, for categorical counts like severity. */
export function BreakdownBars({
  items,
  toneFor,
}: {
  items: readonly { label: string; count: number }[];
  toneFor?: (label: string) => string;
}) {
  const total = items.reduce((sum, item) => sum + item.count, 0);

  if (total === 0) {
    return <WidgetEmpty message="Nothing to break down yet." />;
  }

  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item) => (
        <li key={item.label} className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-caption">
            <span className="text-foreground capitalize">{item.label.replace(/_/g, " ")}</span>
            <span className="text-foreground-muted tabular-nums">{item.count}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-background-secondary">
            <div
              className={cn("h-full rounded-full", toneFor?.(item.label) ?? "bg-primary")}
              style={{ width: `${Math.round((item.count / total) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
