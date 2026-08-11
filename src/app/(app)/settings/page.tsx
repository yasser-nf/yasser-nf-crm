import type { Metadata } from "next";
import { Suspense } from "react";

import { USER_ROLES } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import {
  SettingsCategoryGrid,
  SettingsHistory,
  SettingsSearch,
  SettingsSearchResults,
  settingsService,
  type SettingsCategory,
} from "@/modules/settings";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "Settings" };

/**
 * Settings overview.
 *
 * Three things: search across every setting, the category grid, and the change
 * history. The history is the M11 audit requirement rendered — who changed
 * what, when, and from what to what.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params["q"];
  const query = (Array.isArray(raw) ? raw[0] : raw) ?? "";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title text-foreground">Settings</h1>
        <p className="text-description text-foreground-muted">
          Every configurable aspect of the CRM. Changes are validated and audited.
        </p>
      </header>

      <Suspense fallback={<Skeleton className="h-11 w-full max-w-sm" />}>
        <SettingsSearch />
      </Suspense>

      <Suspense key={query} fallback={<Skeleton className="h-24 w-full" />}>
        <SearchResults query={query} />
      </Suspense>

      <Suspense fallback={<GridSkeleton />}>
        <Categories />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-32 w-full" />}>
        <History />
      </Suspense>
    </div>
  );
}

async function SearchResults({ query }: { query: string }) {
  const actor = await getCurrentUser();
  const matches = settingsService.search(query, actor);

  return <SettingsSearchResults matches={matches} query={query} />;
}

async function Categories() {
  const actor = await getCurrentUser();
  const isSuperAdmin = actor?.role === USER_ROLES.SUPER_ADMIN;

  const visible: SettingsCategory[] = isSuperAdmin
    ? ["general", "company", "security", "backups", "notifications", "system"]
    : ["general", "company"];

  return <SettingsCategoryGrid visible={visible} />;
}

/**
 * Change history.
 *
 * Renders nothing for a role that may not read it — the service refuses, and a
 * second refusal banner under the categories would add noise without adding
 * information.
 */
async function History() {
  const actor = await getCurrentUser();
  const changes = await settingsService.history(actor, 20);

  if (!changes.ok) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-section-title text-foreground">Recent changes</h2>
      <SettingsHistory changes={changes.value} />
    </section>
  );
}

/** 04_UI_GUIDELINES.md: skeletons, never spinners, matching the real layout. */
function GridSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-24 w-full" />
      ))}
    </div>
  );
}
