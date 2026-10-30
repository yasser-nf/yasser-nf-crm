"use client";

import Link from "next/link";

import { ROUTES } from "@/config/constants";
import type { AccountView } from "@/modules/accounts";
import type { SupplierOption } from "@/shared/forms/ownership-fields";
import { AssignSupplierButton } from "./assign-supplier-dialog";

/**
 * Supplied accounts with no supplier recorded (M09B) — the triage queue.
 *
 * This list is the reason the database permits "supplied, supplier unknown".
 * An operator importing stock often knows an account came from outside before
 * they remember from whom; refusing that combination would push them to
 * mislabel it `owned`, which is the one answer nobody would ever come back to
 * fix. Recorded honestly, it shows up here until it is resolved.
 */
export function UnassignedAccounts({
  accounts,
  suppliers,
  canManage,
}: {
  readonly accounts: readonly AccountView[];
  readonly suppliers: readonly SupplierOption[];
  readonly canManage: boolean;
}) {
  if (accounts.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning-subtle p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-section-title text-foreground">Supplied, supplier not recorded</h2>
        <p className="text-description text-foreground-muted">
          {accounts.length} account{accounts.length === 1 ? "" : "s"} came from outside the business
          but do not say from whom. Each one still sells normally — this is a bookkeeping gap, not a
          fault.
        </p>
      </header>

      <ul className="flex flex-col gap-2">
        {accounts.map((account) => (
          <li
            key={account.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2"
          >
            <Link
              href={`${ROUTES.ACCOUNTS}/${account.id}`}
              className="font-mono text-caption text-foreground hover:underline"
            >
              {account.email}
            </Link>

            {canManage ? (
              <AssignSupplierButton
                account={{
                  id: account.id,
                  email: account.email,
                  ownership: account.ownership,
                  supplierId: account.supplierId,
                }}
                suppliers={suppliers}
                label="Choose supplier"
              />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
