import { ShieldAlert } from "lucide-react";

import { getCurrentUser } from "@/lib/auth/session";
import { ErrorState } from "@/shared/feedback/error-state";
import { settingsService } from "../services/settings.service";
import type { Configuration } from "../validation/configuration.schema";
import type { SettingsCategory } from "../services/settings-definitions";
import { SettingsForm } from "./settings-form";

/**
 * One settings category, loaded and rendered.
 *
 * A server component in the module rather than six near-identical pages. The
 * pages under app/ stay what 02_ARCHITECTURE.md requires them to be — route
 * composition and nothing else — while the loading happens once here.
 *
 * It holds no business logic: it asks the service for the view, and the service
 * decides what this caller may see and change.
 */

/** Which jsonb key a category's values live under. */
const VALUES_KEY: Record<Exclude<SettingsCategory, "system">, keyof Configuration> = {
  general: "general",
  company: "company",
  security: "security",
  notifications: "notifications",
  backups: "backup",
};

export async function SettingsCategorySection({
  category,
  title,
  description,
}: {
  category: Exclude<SettingsCategory, "system">;
  title: string;
  description: string;
}) {
  const actor = await getCurrentUser();
  const view = await settingsService.load(actor);

  if (!view.ok) {
    return <ErrorState error={view.error} title="Could not load settings" />;
  }

  const definitions = settingsService.forCategory(category, actor);

  if (definitions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-16 text-center">
        <ShieldAlert className="size-6 text-foreground-subtle" aria-hidden="true" />
        <h2 className="text-section-title text-foreground">Not available to your role</h2>
        <p className="max-w-sm text-description text-foreground-muted">
          These settings are restricted to Super Admins.
        </p>
      </div>
    );
  }

  const values = view.value.configuration[VALUES_KEY[category]] as unknown as Record<
    string,
    unknown
  >;

  /* Only the issues that point at this category's fields. */
  const issues = view.value.issues.filter((issue) =>
    definitions.some((definition) => definition.key === issue.key),
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title text-foreground">{title}</h1>
        <p className="text-description text-foreground-muted">{description}</p>
      </header>

      <SettingsForm
        category={category}
        definitions={definitions}
        initialValues={values ?? {}}
        issues={issues}
        canEdit={view.value.canEdit}
      />
    </div>
  );
}
