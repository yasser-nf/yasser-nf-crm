"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Search, SearchX } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";

import { ActionError } from "@/lib/errors";
import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/shared/ui/dialog";
import { Skeleton } from "@/shared/ui/skeleton";
import { cn } from "@/utils/cn";
import { globalSearchAction } from "../actions/search.actions";
import { SEARCH_MAX_LENGTH, normalizeQuery } from "../services/search-terms";
import type { SearchGroup, SearchHit, SearchResponse } from "../services/search-types";

/**
 * Global search (M05) — the box in the top bar, and Ctrl/⌘ K anywhere.
 *
 * Results come from the server, per keystroke pause rather than per keystroke:
 * the query waits DEBOUNCE_MS after the last key, and TanStack Query caches each
 * answer by its text, so typing back to an earlier query asks nothing again.
 *
 * Four states, and they never borrow each other's words:
 *
 *   idle      fewer than two characters: nothing is asked
 *   loading   a skeleton, while typing and while the answer is on its way
 *   error     the search failed — said so, with Try again. Never "no results"
 *   empty     the search worked and nothing matched
 *
 * A single group can fail on its own (see searchService); that group says so
 * in place, and the others still show what they found.
 */

export const DEBOUNCE_MS = 250;

export const SEARCH_QUERY_KEY = "global-search";

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

async function runSearch(query: string): Promise<SearchResponse> {
  const result = await globalSearchAction(query);

  if (!result.ok) {
    throw new ActionError(result.message, result.code);
  }

  return result.data;
}

export function GlobalSearch() {
  const [open, setOpen] = useState(false);

  /* 04_UI_GUIDELINES.md: global search is always reachable with Ctrl+K. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        aria-keyshortcuts="Control+K Meta+K"
        className="h-9 max-w-sm min-w-0 flex-1 justify-start gap-2 border-border bg-background-secondary px-3 text-foreground-subtle hover:text-foreground"
      >
        <Search className="size-4" aria-hidden="true" />
        <span className="truncate text-description">Search</span>
        <kbd className="ml-auto hidden items-center gap-0.5 rounded border border-border px-1.5 py-0.5 font-mono text-caption text-foreground-subtle sm:inline-flex">
          Ctrl K
        </kbd>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="top-4 flex max-h-[calc(100dvh-2rem)] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:top-[12vh] sm:max-h-[76vh] sm:max-w-xl"
        >
          {/* Mounted only while open, so every opening starts from an empty box. */}
          {open ? <SearchPanel onNavigate={() => setOpen(false)} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function SearchPanel({ onNavigate }: { onNavigate: () => void }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

  const debounced = useDebouncedValue(text, DEBOUNCE_MS);
  const query = normalizeQuery(debounced);
  const typing = normalizeQuery(text) !== query;

  const search = useQuery({
    queryKey: [SEARCH_QUERY_KEY, query],
    queryFn: () => runSearch(query ?? ""),
    enabled: query !== null,
    staleTime: 30_000,
    /* One retry: a search is interactive, and three attempts would hide a failure for seconds. */
    retry: 1,
  });

  /* Every hit, in display order, for the arrow keys. */
  const hits = useMemo(
    () => (search.data?.groups ?? []).flatMap((group) => (group.status === "ok" ? group.hits : [])),
    [search.data],
  );

  /* A new answer can be shorter than the old one; fall back to the first hit. */
  const activeHit = hits[active] ?? hits[0];

  function open(hit: SearchHit | undefined) {
    if (!hit) return;
    onNavigate();
    router.push(hit.href);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (hits.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (index + 1) % hits.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index - 1 + hits.length) % hits.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      open(activeHit);
    }
  }

  return (
    <>
      <DialogTitle className="sr-only">Search</DialogTitle>
      <DialogDescription className="sr-only">
        Search accounts, profiles, customers and problems. Use the arrow keys to choose a result and
        Enter to open it.
      </DialogDescription>

      <div className="flex items-center gap-2 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <input
          autoFocus
          value={text}
          maxLength={SEARCH_MAX_LENGTH}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search by email, name, phone, profile or problem…"
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeHit ? `${listId}-${activeHit.id}` : undefined}
          aria-label="Search"
          className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-foreground-subtle sm:text-description"
        />
        <kbd className="hidden rounded border border-border px-1.5 py-0.5 font-mono text-caption text-foreground-subtle sm:inline">
          Esc
        </kbd>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        <SearchBody
          query={query}
          typing={typing}
          search={search}
          listId={listId}
          activeId={activeHit?.id}
          onHover={(hit) => setActive(hits.indexOf(hit))}
          onOpen={open}
          onViewAll={(href) => {
            onNavigate();
            router.push(href);
          }}
        />
      </div>
    </>
  );
}

interface SearchBodyProps {
  readonly query: string | null;
  readonly typing: boolean;
  readonly search: UseQueryResult<SearchResponse>;
  readonly listId: string;
  readonly activeId: string | undefined;
  readonly onHover: (hit: SearchHit) => void;
  readonly onOpen: (hit: SearchHit) => void;
  readonly onViewAll: (href: string) => void;
}

function SearchBody({
  query,
  typing,
  search,
  listId,
  activeId,
  onHover,
  onOpen,
  onViewAll,
}: SearchBodyProps) {
  if (query === null && !typing) {
    return (
      <p className="px-3 py-8 text-center text-description text-foreground-subtle">
        Type at least two characters to search.
      </p>
    );
  }

  if (typing || search.isPending) {
    return <SearchSkeleton />;
  }

  if (search.isError) {
    return (
      <div
        role="alert"
        className="m-2 flex flex-col items-center gap-3 rounded-lg border border-danger/30 bg-danger-subtle px-4 py-6 text-center"
      >
        <AlertTriangle className="size-5 text-danger" aria-hidden="true" />
        <p className="text-description text-foreground">
          {search.error instanceof ActionError
            ? search.error.userMessage
            : "Search could not be completed."}
        </p>
        <Button variant="outline" size="sm" onClick={() => void search.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const groups = search.data.groups;
  const found = groups.some((group) => group.status === "ok" && group.hits.length > 0);
  const failed = groups.some((group) => group.status === "error");

  if (!found && !failed) {
    return (
      <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
        <SearchX className="size-5 text-foreground-subtle" aria-hidden="true" />
        <p className="text-description text-foreground-muted">
          No results for “{search.data.query}”.
        </p>
      </div>
    );
  }

  return (
    <div id={listId} role="listbox" aria-label="Search results" className="flex flex-col gap-3">
      {groups.map((group) => (
        <ResultGroup
          key={group.kind}
          group={group}
          listId={listId}
          activeId={activeId}
          onHover={onHover}
          onOpen={onOpen}
          onViewAll={onViewAll}
        />
      ))}
    </div>
  );
}

function ResultGroup({
  group,
  listId,
  activeId,
  onHover,
  onOpen,
  onViewAll,
}: {
  group: SearchGroup;
  listId: string;
  activeId: string | undefined;
  onHover: (hit: SearchHit) => void;
  onOpen: (hit: SearchHit) => void;
  onViewAll: (href: string) => void;
}) {
  const headingId = `${listId}-${group.kind}`;

  if (group.status === "error") {
    return (
      <div role="group" aria-labelledby={headingId}>
        <GroupHeading id={headingId} label={group.label} />
        <p
          role="alert"
          className="mx-2 flex items-center gap-2 rounded-md bg-danger-subtle px-3 py-2 text-caption text-danger"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          Could not search {group.label.toLowerCase()}.
        </p>
      </div>
    );
  }

  if (group.hits.length === 0) {
    return null;
  }

  return (
    <div role="group" aria-labelledby={headingId}>
      <GroupHeading id={headingId} label={group.label} />
      {group.hits.map((hit) => (
        <div
          key={hit.id}
          id={`${listId}-${hit.id}`}
          role="option"
          aria-selected={hit.id === activeId}
          onMouseMove={() => onHover(hit)}
          onClick={() => onOpen(hit)}
          className={cn(
            "flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2",
            hit.id === activeId ? "bg-surface-raised" : "hover:bg-surface-raised",
          )}
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-description text-foreground">{hit.title}</span>
            {hit.subtitle ? (
              <span className="truncate text-caption text-foreground-subtle">{hit.subtitle}</span>
            ) : null}
          </div>
          {hit.badge ? (
            <span
              className={cn(
                "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-caption font-medium whitespace-nowrap",
                hit.badge.className,
              )}
            >
              {hit.badge.label}
            </span>
          ) : null}
        </div>
      ))}
      {group.viewAllHref ? (
        <button
          type="button"
          onClick={() => onViewAll(group.viewAllHref as string)}
          className="mx-1 mt-1 flex min-h-9 items-center gap-1 rounded-md px-2 text-caption text-primary hover:bg-surface-raised"
        >
          View all in {group.label}
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function GroupHeading({ id, label }: { id: string; label: string }) {
  return (
    <p
      id={id}
      className="px-3 pt-1 pb-1 text-caption font-medium tracking-wide text-foreground-subtle uppercase"
    >
      {label}
    </p>
  );
}

function SearchSkeleton() {
  return (
    <div aria-busy="true" aria-label="Searching" className="flex flex-col gap-2 p-2">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-center gap-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-5 w-16" />
        </div>
      ))}
    </div>
  );
}
