"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { ACTION_LABELS, AUDIT_ACTIONS, AUDIT_ENTITIES, ENTITY_LABELS } from "../services/log-view";

/**
 * Logs filters. Every filter is a query-string parameter the server reads and
 * validates; nothing is filtered in the browser.
 *
 * Dates are UTC days, and say so: an entry at 00:30 in Algiers belongs to the
 * previous UTC day, the same day the dashboard and reports put it on.
 */

const SELECT = "h-10 rounded-md border border-border bg-surface px-3 text-caption text-foreground";

export function LogsFilters({ actors }: { actors: readonly { id: string; name: string }[] }) {
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

  /* Debounced, like every search box in the application. */
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

  const keys = ["search", "actor", "entity", "action", "from", "to"];
  const hasFilters = keys.some((key) => searchParams.get(key));

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
          placeholder="Person, email, action, entity or ID"
          aria-label="Search the audit log"
          className="h-11 pl-9"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={searchParams.get("actor") ?? ""}
          onChange={(event) => setParam("actor", event.target.value || null)}
          aria-label="Filter by person"
          className={SELECT}
        >
          <option value="">Everyone</option>
          {actors.map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.name}
            </option>
          ))}
        </select>

        <select
          value={searchParams.get("entity") ?? ""}
          onChange={(event) => setParam("entity", event.target.value || null)}
          aria-label="Filter by entity"
          className={SELECT}
        >
          <option value="">All entities</option>
          {AUDIT_ENTITIES.map((entity) => (
            <option key={entity} value={entity}>
              {ENTITY_LABELS[entity]}
            </option>
          ))}
        </select>

        <select
          value={searchParams.get("action") ?? ""}
          onChange={(event) => setParam("action", event.target.value || null)}
          aria-label="Filter by action"
          className={SELECT}
        >
          <option value="">All actions</option>
          {AUDIT_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {ACTION_LABELS[action]}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-caption text-foreground-muted">
          From
          <input
            type="date"
            value={searchParams.get("from") ?? ""}
            onChange={(event) => setParam("from", event.target.value || null)}
            aria-label="From date (UTC, inclusive)"
            className={SELECT}
          />
        </label>

        <label className="flex items-center gap-2 text-caption text-foreground-muted">
          To
          <input
            type="date"
            value={searchParams.get("to") ?? ""}
            onChange={(event) => setParam("to", event.target.value || null)}
            aria-label="To date (UTC, inclusive)"
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
