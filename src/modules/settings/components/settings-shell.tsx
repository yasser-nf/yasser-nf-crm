"use client";

import {
  Bell,
  Building2,
  DatabaseBackup,
  Search,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ROUTES } from "@/config/constants";
import { Input } from "@/shared/ui/input";
import { cn } from "@/utils/cn";
import type { SettingsCategory } from "../services/settings-definitions";

/**
 * Settings navigation and search.
 *
 * The category list is declared once here and every page shares it, so a new
 * category appears in the nav by adding one entry rather than editing six
 * pages.
 */

const CATEGORIES: readonly {
  key: SettingsCategory;
  label: string;
  href: string;
  icon: typeof SettingsIcon;
  description: string;
}[] = [
  {
    key: "general",
    label: "General",
    href: `${ROUTES.SETTINGS}/general`,
    icon: SettingsIcon,
    description: "Application name, timezone, date format",
  },
  {
    key: "company",
    label: "Company",
    href: `${ROUTES.SETTINGS}/company`,
    icon: Building2,
    description: "Contact details shown on printed reports",
  },
  {
    key: "security",
    label: "Security",
    href: `${ROUTES.SETTINGS}/security`,
    icon: ShieldCheck,
    description: "Sessions, password policy, account locking",
  },
  {
    key: "backups",
    label: "Backups",
    href: `${ROUTES.SETTINGS}/backups`,
    icon: DatabaseBackup,
    description: "Schedule and retention",
  },
  {
    key: "notifications",
    label: "Notifications",
    href: `${ROUTES.SETTINGS}/notifications`,
    icon: Bell,
    description: "What the system would tell you about",
  },
  {
    key: "system",
    label: "System",
    href: `${ROUTES.SETTINGS}/system`,
    icon: Server,
    description: "Versions, migrations, storage, health",
  },
];

export function SettingsNav({ visible }: { visible: readonly SettingsCategory[] }) {
  const pathname = usePathname();
  const shown = CATEGORIES.filter((category) => visible.includes(category.key));

  return (
    <nav aria-label="Settings categories" className="flex flex-wrap gap-2">
      {shown.map((category) => {
        const active = pathname === category.href;

        return (
          <Link
            key={category.key}
            href={category.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-caption transition-colors",
              active
                ? "border-primary/40 bg-primary-subtle text-primary"
                : "border-border bg-surface text-foreground-muted hover:bg-surface-raised",
            )}
          >
            <category.icon className="size-3.5" aria-hidden="true" />
            {category.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SettingsCategoryGrid({ visible }: { visible: readonly SettingsCategory[] }) {
  const shown = CATEGORIES.filter((category) => visible.includes(category.key));

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {shown.map((category) => (
        <Link
          key={category.key}
          href={category.href}
          className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-5 transition-colors hover:bg-surface-raised"
        >
          <span className="flex items-center gap-2.5">
            <category.icon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
            <span className="text-card-title text-foreground">{category.label}</span>
          </span>
          <span className="text-caption text-foreground-muted">{category.description}</span>
        </Link>
      ))}
    </div>
  );
}

/**
 * Search across every setting.
 *
 * Kept in the URL so a search is shareable and survives a refresh, matching how
 * every other list in the CRM behaves.
 */
export function SettingsSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const current = searchParams.get("q") ?? "";
  const [value, setValue] = useState(current);
  const [synced, setSynced] = useState(current);

  if (current !== synced) {
    setSynced(current);
    setValue(current);
  }

  /* Debounced: one request per keystroke lets responses arrive out of order. */
  useEffect(() => {
    if (value === current) return;

    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (value.trim()) params.set("q", value.trim());
      else params.delete("q");
      router.push(`${pathname}?${params.toString()}`);
    }, 300);

    return () => clearTimeout(timer);
  }, [value, current, pathname, router, searchParams]);

  return (
    <div className="relative w-full sm:max-w-sm">
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground-subtle"
        aria-hidden="true"
      />
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search every setting"
        aria-label="Search settings"
        className="h-11 pl-9"
      />
    </div>
  );
}
