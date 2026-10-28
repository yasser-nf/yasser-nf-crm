import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import { QuickRenewScreen } from "@/modules/quick-renew";

export const metadata: Metadata = { title: "Quick Renewing" };

/**
 * Quick Renewing (M09A).
 *
 * Route composition only. The service checks `renew_subscriptions` on every
 * call it serves; this page renders the refusal for a role that may not be
 * here at all, so a Worker without the permission is told why rather than
 * shown a form that will refuse every submission.
 */
export default async function QuickRenewPage() {
  const actor = await getCurrentUser();
  const permitted =
    actor !== null && roleHasPermission(actor.role, PERMISSIONS.RENEW_SUBSCRIPTIONS);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title text-foreground">Quick Renewing</h1>
        <p className="text-description text-foreground-muted">
          Extend the subscription on a profile a customer already holds. This does not sell another
          profile or move the customer to a different account.
        </p>
      </header>

      {permitted ? (
        <QuickRenewScreen />
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-16 text-center">
          <ShieldAlert className="size-6 text-foreground-subtle" aria-hidden="true" />
          <h2 className="text-section-title text-foreground">Not available to your role</h2>
          <p className="max-w-sm text-description text-foreground-muted">
            Renewing subscriptions is restricted.
          </p>
        </div>
      )}
    </div>
  );
}
