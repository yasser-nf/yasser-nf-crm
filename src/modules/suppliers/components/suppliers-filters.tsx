"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

/**
 * Suppliers page filters (M09B).
 *
 * The filter state lives in the URL and is applied by PostgreSQL, exactly as
 * on the Jobs and Accounts lists — so a filtered view can be linked to, and
 * the browser never holds more than one page of suppliers.
 */
export function SuppliersFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const current = searchParams.get("search") ?? "";
  const [value, setValue] = useState(current);
  const [synced, setSynced] = useState(current);

  /* Adjust during render when the URL moves under us — the codebase's idiom. */
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

  const showingArchived = searchParams.get("archived") === "1";

  function toggleArchived() {
    const params = new URLSearchParams(searchParams.toString());
    if (showingArchived) params.delete("archived");
    else params.set("archived", "1");
    params.set("offset", "0");
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative sm:max-w-md sm:flex-1">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground-subtle"
          aria-hidden="true"
        />
        <Input
          value={value}
          maxLength={120}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Search by name"
          aria-label="Search suppliers"
          className="h-11 pl-9"
        />
      </div>

      <Button variant={showingArchived ? "default" : "outline"} onClick={toggleArchived}>
        {showingArchived ? "Showing archived" : "Show archived"}
      </Button>
    </div>
  );
}
