import type { Metadata } from "next";

import { QuickReplaceScreen } from "@/modules/quick-prepare";

export const metadata: Metadata = {
  title: "Quick Replace",
};

/**
 * Never prerendered, never cached.
 *
 * Everything on this page is looked up on demand against live stock. The same
 * reasoning as Quick Prepare: an operator shown a cached account state is an
 * operator about to move a customer onto a profile that is already gone.
 */
export const dynamic = "force-dynamic";

/**
 * Quick Replace — M13 §9.
 *
 * The account went bad and a customer is on it. Look it up by the email they
 * were given, see the whole account, and move them without losing the time they
 * paid for.
 *
 * The page itself reads nothing on the server. Unlike Quick Prepare, there is no
 * useful thing to know before the operator has said WHICH account — a stock
 * count would answer a question nobody has asked yet.
 */
export default function QuickReplacePage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title text-foreground">Quick Replace</h1>
        <p className="text-description text-foreground-muted">
          Move a customer off a broken account. They keep the days they paid for.
        </p>
      </header>

      <QuickReplaceScreen />
    </div>
  );
}
