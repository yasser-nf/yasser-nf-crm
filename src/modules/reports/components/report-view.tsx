"use client";

import { useMutation } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Printer, Save, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ROUTES } from "@/config/constants";
import { ActionError } from "@/lib/errors";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";
import { cn } from "@/utils/cn";
import { savePresetAction, type ActionResult } from "../actions/report.actions";
import type { ReportDefinition } from "../services/report-definitions";
import type { ReportRow, ReportSummary } from "../repositories/reports.repository";

/**
 * A single report.
 *
 * Filters live in the URL, so a filtered view is shareable, bookmarkable and
 * survives a refresh — and the export link is built from the very same query
 * string, which is what makes "export only filtered results" true by
 * construction rather than by remembering to pass the filters twice.
 */

interface Props {
  readonly definition: ReportDefinition;
  readonly summary: ReportSummary;
  readonly rows: readonly ReportRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly presets: readonly { id: string; name: string; filters: unknown }[];
}

function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) return result.data;
  throw new ActionError(result.message, result.code);
}

function formatSummaryValue(value: number | string | null): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(1);
  }
  return value;
}

function humanise(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (character) => character.toUpperCase())
    .trim();
}

export function ReportView({ definition, summary, rows, total, limit, offset, presets }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const [presetName, setPresetName] = useState("");

  const currentSearch = searchParams.get("search") ?? "";

  /* Debounced: one request per keystroke lets responses arrive out of order. */
  useEffect(() => {
    if (search === currentSearch) return;

    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (search.trim()) params.set("search", search.trim());
      else params.delete("search");
      params.set("offset", "0");
      router.push(`${pathname}?${params.toString()}`);
    }, 300);

    return () => clearTimeout(timer);
  }, [search, currentSearch, pathname, router, searchParams]);

  function setParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
    params.set("offset", "0");
    router.push(`${pathname}?${params.toString()}`);
  }

  /* The export URL carries the same query string the page is showing. */
  function exportHref(format: "csv" | "excel" | "pdf"): string {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("offset");
    params.set("report", definition.key);
    params.set("format", format);
    return `/api/reports/export?${params.toString()}`;
  }

  const savePreset = useMutation({
    mutationFn: async () =>
      unwrap(
        await savePresetAction({
          report: definition.key,
          name: presetName,
          filters: Object.fromEntries(searchParams.entries()),
          columns: definition.columns.map((column) => column.key),
          sort: {},
          exportFormat: "csv",
        }),
      ),
    onSuccess: () => {
      toast.success("Preset saved");
      setPresetName("");
      router.refresh();
    },
    onError: (error) => toast.error("Could not save", { description: error.userMessage }),
  });

  const hasFilters = [...searchParams.keys()].some((key) => key !== "offset");
  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(Math.ceil(total / limit), 1);

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={ROUTES.REPORTS}
        className="inline-flex w-fit items-center gap-1.5 text-caption text-foreground-muted hover:text-foreground"
      >
        &larr; All reports
      </Link>

      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-page-title text-foreground">{definition.title}</h1>
          <p className="text-description text-foreground-muted">{definition.description}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm" className="gap-2">
            <a href={exportHref("csv")} download>
              <Download className="size-3.5" aria-hidden="true" />
              CSV
            </a>
          </Button>
          <Button asChild variant="outline" size="sm" className="gap-2">
            <a href={exportHref("excel")} download>
              <FileSpreadsheet className="size-3.5" aria-hidden="true" />
              Excel
            </a>
          </Button>
          <Button asChild variant="outline" size="sm" className="gap-2">
            <a href={exportHref("pdf")} target="_blank" rel="noreferrer">
              <Printer className="size-3.5" aria-hidden="true" />
              Print / PDF
            </a>
          </Button>
        </div>
      </header>

      {/* Summary — aggregates over the whole filtered set, not just this page. */}
      {Object.keys(summary).length > 0 ? (
        <section className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-surface p-5 sm:grid-cols-3 lg:grid-cols-4">
          {Object.entries(summary).map(([key, value]) => (
            <div key={key} className="flex flex-col gap-1">
              <span className="text-caption text-foreground-subtle">{humanise(key)}</span>
              <span className="text-section-title text-foreground tabular-nums">
                {formatSummaryValue(value)}
              </span>
            </div>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {definition.searchable ? (
            <div className="relative flex-1 sm:max-w-sm">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground-subtle"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search this report"
                aria-label="Search report"
                className="h-10 pl-9"
              />
            </div>
          ) : null}

          {definition.filters.includes("dateRange") ? (
            <>
              <input
                type="date"
                value={searchParams.get("from") ?? ""}
                onChange={(event) => setParam("from", event.target.value)}
                aria-label="From"
                className="h-10 rounded-md border border-border bg-surface px-3 text-caption text-foreground"
              />
              <input
                type="date"
                value={searchParams.get("to") ?? ""}
                onChange={(event) => setParam("to", event.target.value)}
                aria-label="To"
                className="h-10 rounded-md border border-border bg-surface px-3 text-caption text-foreground"
              />
            </>
          ) : null}

          {definition.filters.includes("severity") ? (
            <select
              value={searchParams.get("severity") ?? ""}
              onChange={(event) => setParam("severity", event.target.value)}
              aria-label="Severity"
              className="h-10 rounded-md border border-border bg-surface px-3 text-caption text-foreground"
            >
              <option value="">All severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          ) : null}

          {definition.filters.includes("status") ? (
            <Input
              value={searchParams.get("status") ?? ""}
              onChange={(event) => setParam("status", event.target.value)}
              placeholder="Status"
              aria-label="Status"
              className="h-10 w-36"
            />
          ) : null}

          {hasFilters ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(pathname)}
              className="gap-1.5"
            >
              <X className="size-4" aria-hidden="true" />
              Clear
            </Button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={presetName}
            onChange={(event) => setPresetName(event.target.value)}
            placeholder="Save this view as…"
            aria-label="Preset name"
            className="h-9 w-52"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => savePreset.mutate()}
            disabled={savePreset.isPending || presetName.trim().length === 0}
            className="gap-1.5"
          >
            <Save className="size-3.5" aria-hidden="true" />
            Save preset
          </Button>

          {presets.map((preset) => (
            <Button
              key={preset.id}
              variant="ghost"
              size="sm"
              onClick={() => {
                const params = new URLSearchParams(
                  Object.entries((preset.filters ?? {}) as Record<string, string>).filter(
                    ([, value]) => typeof value === "string" && value.length > 0,
                  ),
                );
                router.push(`${pathname}?${params.toString()}`);
              }}
            >
              {preset.name}
            </Button>
          ))}
        </div>
      </section>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-6 py-12 text-center text-description text-foreground-muted">
          No rows match these filters.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-surface">
              <TableRow className="hover:bg-transparent">
                {definition.columns.map((column) => (
                  <TableHead
                    key={column.key}
                    className={cn(
                      "text-caption text-foreground-muted",
                      column.numeric && "text-right",
                    )}
                  >
                    {column.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>

            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={index} className="border-b border-border last:border-0">
                  {definition.columns.map((column) => (
                    <TableCell
                      key={column.key}
                      className={cn(
                        "text-caption text-foreground-muted",
                        column.numeric && "text-right tabular-nums",
                      )}
                    >
                      {row[column.key] === null || row[column.key] === undefined
                        ? "—"
                        : String(row[column.key])}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {total > limit ? (
        <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
          <p className="text-caption text-foreground-subtle">
            {total.toLocaleString()} rows · page {page} of {pageCount}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setParam("offset", String(Math.max(offset - limit, 0)))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + limit >= total}
              onClick={() => setParam("offset", String(offset + limit))}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
