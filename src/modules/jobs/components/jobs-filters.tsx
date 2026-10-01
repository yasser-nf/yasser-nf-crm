"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { JOB_STATUSES } from "../services/job-states";
import { JOB_STATUS_LABELS } from "../services/job-view";

/**
 * Jobs page filters (M08 jobs). Everything lives in the URL and is applied on
 * the server; the browser never holds more than one page of jobs.
 */

const SELECT = "h-10 rounded-md border border-border bg-surface px-3 text-caption text-foreground";

export function JobsFilters({ types }: { types: readonly string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const current = searchParams.get("search") ?? "";
  const [value, setValue] = useState(current);
  const [synced, setSynced] = useState(current);

  if (current !== synced) {
    setSynced(current);
    setValue(current);
  }

  useEffect(() => {
    if (value === current) {
      return;
    }

    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (value.trim()) params.set("search", value.trim());
      else params.delete("search");
      params.set("offset", "0");
      router.push(`${pathname}?${params.toString()}`);
    }, 300);

    return () => clearTimeout(timer);
  }, [value, current, pathname, router, searchParams]);

  function setParam(key: string, next: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === null) params.delete(key);
    else params.set(key, next);
    params.set("offset", "0");
    router.push(`${pathname}?${params.toString()}`);
  }

  const hasFilters = ["search", "type", "status", "from", "to"].some((key) =>
    searchParams.get(key),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="relative sm:max-w-md">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground-subtle"
          aria-hidden="true"
        />
        <Input
          value={value}
          maxLength={100}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Job ID, type or key"
          aria-label="Search jobs"
          className="h-11 pl-9"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={searchParams.get("type") ?? ""}
          onChange={(event) => setParam("type", event.target.value || null)}
          aria-label="Filter by type"
          className={SELECT}
        >
          <option value="">All types</option>
          {types.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>

        <select
          value={searchParams.get("status") ?? ""}
          onChange={(event) => setParam("status", event.target.value || null)}
          aria-label="Filter by status"
          className={SELECT}
        >
          <option value="">All statuses</option>
          {JOB_STATUSES.map((status) => (
            <option key={status} value={status}>
              {JOB_STATUS_LABELS[status]}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-caption text-foreground-muted">
          From
          <input
            type="date"
            value={searchParams.get("from") ?? ""}
            onChange={(event) => setParam("from", event.target.value || null)}
            aria-label="Created from (UTC, inclusive)"
            className={SELECT}
          />
        </label>

        <label className="flex items-center gap-2 text-caption text-foreground-muted">
          To
          <input
            type="date"
            value={searchParams.get("to") ?? ""}
            onChange={(event) => setParam("to", event.target.value || null)}
            aria-label="Created to (UTC, inclusive)"
            className={SELECT}
          />
        </label>

        <span className="text-caption text-foreground-subtle">Dates are UTC days.</span>

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
    </div>
  );
}
