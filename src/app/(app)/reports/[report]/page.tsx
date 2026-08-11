import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/errors";
import { ReportView, isReportKey, parseFilters, reportsService } from "@/modules/reports";
import { ErrorState } from "@/shared/feedback/error-state";

export const metadata: Metadata = { title: "Report" };

/**
 * A single report.
 *
 * Filters come from the query string and are validated before they reach SQL.
 * Authorization belongs to the service, which checks the permission the report
 * itself declares; this page renders whatever comes back, including a refusal.
 */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ report: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { report } = await params;

  if (!isReportKey(report)) {
    notFound();
  }

  const query = await searchParams;
  const filters = parseFilters(query);
  const actor = await getCurrentUser();

  const offsetRaw = Number.parseInt(
    (Array.isArray(query["offset"]) ? query["offset"][0] : query["offset"]) ?? "0",
    10,
  );

  const [payload, presets] = await Promise.all([
    reportsService.run(report, filters, actor, {
      offset: Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0,
    }),
    reportsService.listPresets(actor, report),
  ]);

  if (!payload.ok) {
    if (payload.error instanceof ForbiddenError) {
      return (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-16 text-center">
          <ShieldAlert className="size-6 text-foreground-subtle" aria-hidden="true" />
          <h2 className="text-section-title text-foreground">Not available to your role</h2>
          <p className="max-w-sm text-description text-foreground-muted">
            {payload.error.userMessage}
          </p>
        </div>
      );
    }

    return <ErrorState error={payload.error} title="Could not run this report" />;
  }

  return (
    <ReportView
      definition={payload.value.definition}
      summary={payload.value.summary}
      rows={payload.value.rows}
      total={payload.value.total}
      limit={payload.value.limit}
      offset={payload.value.offset}
      presets={
        presets.ok
          ? presets.value.map((preset) => ({
              id: preset.id,
              name: preset.name,
              filters: preset.filters,
            }))
          : []
      }
    />
  );
}
