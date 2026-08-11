import { ChartColumn, FileText } from "lucide-react";
import Link from "next/link";

import { ROUTES } from "@/config/constants";
import { EmptyState } from "@/shared/feedback/empty-state";
import type { ReportDefinition } from "../services/report-definitions";

/**
 * The report catalogue.
 *
 * A Server Component listing only the reports this caller may run — the list
 * comes from `reportsService.catalogue`, which filters by each report's declared
 * permission. A Worker is never shown a card they would then be refused.
 */
export function ReportsCatalogue({ reports }: { reports: readonly ReportDefinition[] }) {
  if (reports.length === 0) {
    return (
      <EmptyState
        icon={ChartColumn}
        title="No reports available"
        description="Your role does not have access to any reports."
      />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {reports.map((report) => (
        <Link
          key={report.key}
          href={`${ROUTES.REPORTS}/${report.key}`}
          className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-5 transition-colors hover:bg-surface-raised"
        >
          <span className="flex items-center gap-2.5">
            <FileText className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
            <span className="text-card-title text-foreground">{report.title}</span>
          </span>
          <span className="text-caption text-foreground-muted">{report.description}</span>
          <span className="mt-1 text-caption text-foreground-subtle">
            {report.columns.length} columns
            {report.filters.length > 0 ? ` · ${report.filters.length} filters` : ""}
          </span>
        </Link>
      ))}
    </div>
  );
}
