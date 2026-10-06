import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import { getCurrentUser } from "@/lib/auth/session";
import { QuickRenewScreen } from "@/modules/quick-renew";

export const metadata: Metadata = {
  title: "Quick Renew",
};

/**
 * Never prerendered, never cached.
 *
 * Everything on this page is looked up on demand against live data. An operator
 * shown a cached expiry is an operator about to quote a customer a date that
 * has already moved. The same reasoning as Quick Prepare and Quick Replace.
 */
export const dynamic = "force-dynamic";

/**
 * Quick Renew — M09.
 *
 * A customer is on the phone and wants more time. Look up the account email
 * they were given, pick their profile, choose a length, and confirm.
 *
 * The permission check here hides a page nobody may use; it is NOT the
 * authorization. `quickRenewService` checks RENEW_SUBSCRIPTIONS on every entry
 * point including the read-only lookup, because a Server Action is a POST
 * endpoint anybody holding a session can call directly (M09 §22).
 *
 * The page reads nothing else on the server. Unlike Quick Prepare there is no
 * useful thing to know before the operator has said WHICH account — a stock
 * count answers a question nobody has asked here.
 */
export default async function QuickRenewPage() {
  const actor = await getCurrentUser();
  const permitted =
    actor !== null && roleHasPermission(actor.role, PERMISSIONS.RENEW_SUBSCRIPTIONS);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title text-foreground">Quick Renew</h1>
        <p className="text-description text-foreground-muted">
          Extend a customer&rsquo;s subscription. A live subscription is extended from its current
          expiry, so no paid day is lost.
        </p>
      </header>

      {permitted ? (
        <QuickRenewScreen />
      ) : (
        <section className="flex items-start gap-3 rounded-lg border border-border bg-surface p-5">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <h2 className="text-card-title text-foreground">Not available to your role</h2>
            <p className="text-caption text-foreground-muted">
              Renewing a subscription requires the renew permission. Ask a Super Admin if you need
              it.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
