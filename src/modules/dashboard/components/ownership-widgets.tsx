import { Boxes, Building2 } from "lucide-react";
import Link from "next/link";

import { ROUTES } from "@/config/constants";
import type { SupplierOwnership } from "../services/dashboard.service";
import { Metric, MetricGrid, Widget, WidgetEmpty, WidgetForbidden } from "./dashboard-primitives";

/**
 * Ownership and supplier widgets. M10 §14.
 *
 * Two cards and a table, in the dashboard's existing vocabulary — `Widget`,
 * `Metric`, `MetricGrid`. M10 §14 is explicit that the dashboard must not be
 * redesigned and that a table beats a chart where a table is clearer, and for
 * "which supplier, how many, how many broken" a table is clearer.
 *
 * Every number arrives computed. These components do no arithmetic at all, not
 * even the total: `tallySupplierOwnership` adds My Accounts and supplier
 * accounts together, because a total assembled in the markup is a total that
 * can disagree with its parts.
 */

/** My Accounts against supplier accounts. M10 §15. */
export function OwnershipWidget({ ownership }: { ownership: SupplierOwnership | null }) {
  return (
    <Widget
      title="Ownership"
      description="Where these accounts came from"
      icon={Building2}
      action={
        ownership ? (
          <Link href={ROUTES.SUPPLIERS} className="text-caption text-primary hover:underline">
            Suppliers
          </Link>
        ) : null
      }
    >
      {!ownership ? (
        <WidgetForbidden />
      ) : (
        <MetricGrid>
          {/* `supplier_id is null`. The words matter: a blank reads as missing. */}
          <Metric label="My accounts" value={ownership.myAccounts} />
          <Metric label="Supplier accounts" value={ownership.supplierAccounts} tone="muted" />
          <Metric label="Total accounts" value={ownership.totalAccounts} />
        </MetricGrid>
      )}
    </Widget>
  );
}

/**
 * Per-supplier figures. M10 §14.
 *
 * Account figures and the profile figure are in separate columns and are never
 * added together — M10 §13. "50 accounts, 120 available profiles" is one
 * supplier described two ways.
 *
 * Our own accounts are shown as a row too, labelled "My accounts", so the table
 * accounts for every account rather than only the bought ones.
 */
export function SuppliersWidget({ ownership }: { ownership: SupplierOwnership | null }) {
  if (!ownership) {
    return (
      <Widget title="Suppliers" description="Accounts and stock by supplier" icon={Boxes}>
        <WidgetForbidden />
      </Widget>
    );
  }

  /*
   * Our own accounts first, then suppliers by account count. The null row is
   * not a supplier and is not sorted among them: it is the baseline the others
   * are read against.
   */
  const mine = ownership.bySupplier.find((row) => row.supplierId === null);
  const suppliers = ownership.bySupplier
    .filter((row) => row.supplierId !== null)
    .toSorted((left, right) => right.totalAccounts - left.totalAccounts);

  const rows = [...(mine ? [mine] : []), ...suppliers];

  return (
    <Widget
      title="Suppliers"
      description="Accounts and stock by supplier"
      icon={Boxes}
      action={
        <Link href={ROUTES.SUPPLIERS} className="text-caption text-primary hover:underline">
          Manage
        </Link>
      }
    >
      {rows.length === 0 ? (
        <WidgetEmpty message="No accounts yet." />
      ) : (
        /*
         * A definition list rather than a <table>. M10 §29: the dashboard is
         * read on a phone, and four numeric columns in a table either scroll
         * sideways or squeeze below legibility. Each row is a stacked block
         * that reflows, and the numbers stay aligned by `tabular-nums`.
         */
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const name =
              row.supplierId === null
                ? "My accounts"
                : (ownership.names[row.supplierId] ?? "Unknown supplier");

            return (
              <li
                key={row.supplierId ?? "mine"}
                className="flex flex-col gap-2 rounded-md bg-background-secondary p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-description font-medium text-foreground">
                  {row.supplierId === null ? (
                    name
                  ) : (
                    <Link
                      href={`${ROUTES.SUPPLIERS}/${row.supplierId}`}
                      className="hover:text-primary hover:underline"
                    >
                      {name}
                    </Link>
                  )}
                </span>

                <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption">
                  <span className="text-foreground-muted">
                    <span className="text-foreground tabular-nums">{row.totalAccounts}</span>{" "}
                    account{row.totalAccounts === 1 ? "" : "s"}
                  </span>

                  <span
                    className={row.problemAccounts > 0 ? "text-warning" : "text-foreground-subtle"}
                  >
                    <span className="tabular-nums">{row.problemAccounts}</span> with problems
                  </span>

                  {/* A PROFILE figure, labelled as one. M10 §13. */}
                  <span className="text-foreground-muted">
                    <span className="text-foreground tabular-nums">{row.availableProfiles}</span>{" "}
                    available profile{row.availableProfiles === 1 ? "" : "s"}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Widget>
  );
}
