import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/errors";
import { SystemPanel, systemService } from "@/modules/settings";
import { ErrorState } from "@/shared/feedback/error-state";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata: Metadata = { title: "System" };

/**
 * System information.
 *
 * The one settings page with no form. Everything here is measured from the
 * running system rather than configured, so there is nothing to save — and
 * nothing that can disagree with reality.
 */
export default function SystemSettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title text-foreground">System</h1>
        <p className="text-description text-foreground-muted">
          Versions, migrations, storage and health. Measured, not configured.
        </p>
      </header>

      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <System />
      </Suspense>
    </div>
  );
}

async function System() {
  const actor = await getCurrentUser();
  const information = await systemService.information(actor);

  if (!information.ok) {
    if (information.error instanceof ForbiddenError) {
      return (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-16 text-center">
          <ShieldAlert className="size-6 text-foreground-subtle" aria-hidden="true" />
          <h2 className="text-section-title text-foreground">Not available to your role</h2>
          <p className="max-w-sm text-description text-foreground-muted">
            System information is restricted to Super Admins.
          </p>
        </div>
      );
    }

    return <ErrorState error={information.error} title="Could not read system information" />;
  }

  return <SystemPanel information={information.value} />;
}
