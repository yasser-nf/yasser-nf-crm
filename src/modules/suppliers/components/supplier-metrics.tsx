import Link from "next/link";

import { ROUTES } from "@/config/constants";
import { cn } from "@/utils/cn";
import type { SupplierMetrics } from "../repositories/suppliers.repository";

/**
 * The five figures at the top of the Suppliers page (M09B).
 *
 * "Supplied accounts" counts accounts explicitly classified `supplied` and
 * nothing else. An account whose provenance has not been decided is NOT
 * counted here — it is counted as unclassified, which is a different problem
 * with a different fix. Folding the two together would turn "we rely on
 * outside suppliers for N accounts" into a number nobody could act on.
 */
export function SupplierMetricsStrip({ metrics }: { readonly metrics: SupplierMetrics }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Figure label="Suppliers" value={metrics.totalSuppliers} hint="active, not archived" />
      <Figure label="Supplied accounts" value={metrics.suppliedAccounts} hint="not our own stock" />
      <Figure
        label="With problems"
        value={metrics.accountsWithProblems}
        hint="supplied, blocking issue"
        tone={metrics.accountsWithProblems > 0 ? "danger" : "muted"}
      />
      <Figure
        label="Unclassified"
        value={metrics.unknownOwnership}
        hint="provenance not decided"
        tone={metrics.unknownOwnership > 0 ? "warning" : "muted"}
        href={ROUTES.ACCOUNTS}
      />
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  tone = "default",
  href,
}: {
  readonly label: string;
  readonly value: number;
  readonly hint?: string;
  readonly tone?: "default" | "muted" | "warning" | "danger";
  readonly href?: string;
}) {
  const body = (
    <>
      <span className="text-caption text-foreground-subtle">{label}</span>
      <span
        className={cn(
          "text-section-title tabular-nums",
          tone === "danger" && "text-danger",
          tone === "warning" && "text-warning",
          tone === "muted" && "text-foreground-muted",
          tone === "default" && "text-foreground",
        )}
      >
        {value}
      </span>
      {hint ? <span className="text-caption text-foreground-subtle">{hint}</span> : null}
    </>
  );

  const shell = "flex flex-col gap-1 rounded-lg border border-border bg-surface p-4";

  /* Only linked when there is somewhere useful to go, so no dead affordances. */
  return href && value > 0 ? (
    <Link href={href} className={cn(shell, "transition-colors hover:border-primary/40")}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}
