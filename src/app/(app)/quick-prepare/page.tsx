import type { Metadata } from "next";

import { QuickPrepareWizard, quickPrepareService } from "@/modules/quick-prepare";

export const metadata: Metadata = {
  title: "Quick Prepare",
};

/**
 * Never prerendered, never cached.
 *
 * The page reads live stock. Nothing else on it touches a dynamic API, so Next
 * would happily prerender it and freeze the count at build time — and a worker
 * shown stale availability is a worker about to sell a profile that is gone.
 *
 * Today the authenticated layout's session read makes this segment dynamic
 * anyway. That is a side effect, not a guarantee: it would silently stop being
 * true the moment the layout stopped reading cookies. Stating the requirement
 * here means the correctness of this page does not depend on a detail of its
 * parent.
 */
export const dynamic = "force-dynamic";

/**
 * Quick Prepare.
 *
 * 04_UI_GUIDELINES.md calls this the flagship feature and 01_MASTER_RULES.md
 * targets under five seconds end to end.
 *
 * The stock count is read on the server so the page arrives already knowing
 * whether there is anything to sell. A worker should not fill in four fields and
 * only then be told the shelves are empty.
 */
export default async function QuickPreparePage() {
  const stock = await quickPrepareService.availableStock();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title text-foreground">Quick Prepare</h1>
        <p className="text-description text-foreground-muted">
          Find the best accounts, allocate profiles, and send the credentials.
        </p>
      </header>

      {/*
        A failed stock read is not worth blocking the page for. The wizard shows
        zero, and the allocation itself will report the real problem if there is
        one — refusing to render would turn a slow count into an outage.
      */}
      <QuickPrepareWizard availableStock={stock.ok ? stock.value : 0} />
    </div>
  );
}
