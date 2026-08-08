"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { ACCOUNT_STATUS_OPTIONS } from "./status-badge";

/** Sentinel for "no status filter". A Radix SelectItem cannot hold an empty value. */
const ALL_STATUSES = "all";

/**
 * Accounts list filters.
 *
 * Filter state lives in the URL so a view is shareable and survives a refresh.
 *
 * The search box is debounced. Without it, every keystroke would push a route
 * change and re-run the query, which on a slow connection produces a stream of
 * in-flight requests whose responses arrive out of order.
 */
export function AccountsFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const currentSearch = searchParams.get("search") ?? "";
  const currentStatus = searchParams.get("status") ?? ALL_STATUSES;

  const [searchInput, setSearchInput] = useState(currentSearch);

  /* Keep the box in step when the URL changes from elsewhere, such as Clear. */
  const [syncedSearch, setSyncedSearch] = useState(currentSearch);

  if (currentSearch !== syncedSearch) {
    setSyncedSearch(currentSearch);
    setSearchInput(currentSearch);
  }

  useEffect(() => {
    if (searchInput === currentSearch) {
      return;
    }

    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());

      if (searchInput.trim()) {
        params.set("search", searchInput.trim());
      } else {
        params.delete("search");
      }

      /* A new filter means a new result set, so return to the first page. */
      params.set("offset", "0");
      router.push(`${pathname}?${params.toString()}`);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchInput, currentSearch, pathname, router, searchParams]);

  function setStatus(value: string) {
    const params = new URLSearchParams(searchParams.toString());

    if (value === ALL_STATUSES) {
      params.delete("status");
    } else {
      params.set("status", value);
    }

    params.set("offset", "0");
    router.push(`${pathname}?${params.toString()}`);
  }

  const hasFilters = currentSearch !== "" || currentStatus !== ALL_STATUSES;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative flex-1 sm:max-w-xs">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground-subtle"
          aria-hidden="true"
        />
        <Input
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search email, notes, country"
          aria-label="Search accounts"
          className="h-11 pl-9"
        />
      </div>

      <Select value={currentStatus} onValueChange={setStatus}>
        <SelectTrigger className="h-11 sm:w-56" aria-label="Filter by status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_STATUSES}>All statuses</SelectItem>
          {ACCOUNT_STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasFilters ? (
        <Button
          variant="ghost"
          onClick={() => router.push(pathname)}
          className="gap-1.5 text-foreground-muted"
        >
          <X className="size-4" aria-hidden="true" />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
